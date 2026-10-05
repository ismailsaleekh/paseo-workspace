package sh.paseo.visualhostclient

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.Message
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Keeps the companion visual host started and its WebView renderer warm while a Paseo visual
 * surface is active, so the cold start (process, WebView provider, profile renderer) is not paid
 * inside a render's display deadline. It never displays anything: a missing or failing host is
 * reported by the document view that needs it, and this link simply stops until re-acquired.
 */
private class VisualHostWarmup(context: Context) : VisualHostConnection.Listener {
  private val context: Context = context.applicationContext
  private val handler = Handler(Looper.getMainLooper())
  private var link: VisualHostConnection? = null
  private var holders = 0
  private var attempts = 0
  private var receiverRegistered = false
  private val rebind = Runnable { bind() }
  private val installs = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      if (intent.data?.schemeSpecificPart != companionPackage()) return
      attempts = 0
      if (holders > 0 && link == null) bind()
    }
  }

  fun acquire() {
    holders += 1
    if (holders == 1) {
      attempts = 0
      registerInstalls()
    }
    if (link == null) bind()
  }

  fun release() {
    if (holders == 0) return
    holders -= 1
    if (holders == 0) stop()
  }

  /** Drops every holder (module teardown). */
  fun close() {
    holders = 0
    stop()
  }

  private fun stop() {
    handler.removeCallbacks(rebind)
    link?.release()
    link = null
    if (receiverRegistered) {
      receiverRegistered = false
      context.unregisterReceiver(installs)
    }
  }

  override fun onConnected() {
    attempts = 0
    link?.send(VisualHostProtocol.WARM, Bundle())
  }

  override fun onUnavailable(message: String) {
    link = null
    // A force-stopped host restarts at once; an uninstalled one stops after a few attempts and
    // resumes when the package is installed again.
    if (holders > 0 && attempts < MAX_ATTEMPTS) {
      attempts += 1
      handler.postDelayed(rebind, REBIND_DELAY_MS)
    }
  }

  override fun onHostMessage(message: Message) = Unit

  private fun bind() {
    if (holders == 0 || link != null || Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return
    val created = VisualHostConnection(context, this)
    link = created
    created.bind()
  }

  private fun companionPackage(): String = context.packageName + VisualHostProtocol.SERVICE_SUFFIX

  private fun registerInstalls() {
    if (receiverRegistered) return
    val filter = IntentFilter().apply {
      addAction(Intent.ACTION_PACKAGE_ADDED)
      addAction(Intent.ACTION_PACKAGE_REPLACED)
      addDataScheme("package")
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      context.registerReceiver(installs, filter, Context.RECEIVER_NOT_EXPORTED)
    } else {
      context.registerReceiver(installs, filter)
    }
    receiverRegistered = true
  }

  companion object {
    private const val MAX_ATTEMPTS = 3
    private const val REBIND_DELAY_MS = 1_000L
  }
}

/**
 * Android embedding adapter for Pi visuals. Views register under their document session; calls
 * that arrive before React Native has mounted the addressed view wait (bounded) for it.
 */
class PaseoVisualHostModule : Module() {
  private val views = HashMap<String, PaseoVisualHostView>()
  private val waiting = LinkedHashMap<String, MutableList<(PaseoVisualHostView) -> Unit>>()
  private var warmup: VisualHostWarmup? = null

  override fun definition() = ModuleDefinition {
    Name("PaseoVisualHost")

    AsyncFunction("prepare") {
      val context = appContext.reactContext ?: throw IllegalStateException("No Android context")
      val current = warmup ?: VisualHostWarmup(context).also { warmup = it }
      current.acquire()
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("release") {
      warmup?.release()
      Unit
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("open") { session: String, html: String ->
      withView(session) { view -> view.open(session, html) }
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("post") { session: String, message: String ->
      withView(session) { view -> view.post(session, message) }
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("capture") { session: String, request: String ->
      withView(session) { view -> view.capture(session, request) }
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("close") { session: String ->
      waiting.remove(session)
      views[session]?.close(session)
      Unit
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("describe") { session: String ->
      val view = views[session]
      when {
        view != null -> view.describe()
        waiting.containsKey(session) ->
          "view not mounted; ${waiting[session]?.size ?: 0} calls waiting"
        else -> "no view registered for this session"
      }
    }.runOnQueue(Queues.MAIN)

    View(PaseoVisualHostView::class) {
      Events("onHostEvent")
      Prop("session") { view: PaseoVisualHostView, session: String ->
        register(session, view)
      }
      OnViewDestroys { view: PaseoVisualHostView ->
        val sessions = views.filterValues { it === view }.keys.toList()
        for (session in sessions) {
          views.remove(session)
          waiting.remove(session)
        }
        view.dispose()
      }
    }

    OnDestroy {
      for (view in views.values.toSet()) view.dispose()
      views.clear()
      waiting.clear()
      warmup?.close()
      warmup = null
    }
  }

  private fun register(session: String, view: PaseoVisualHostView) {
    require(VisualHostProtocol.isSession(session)) { "Invalid visual session" }
    val previous = views.filterValues { it === view }.keys.filter { it != session }
    for (stale in previous) {
      views.remove(stale)
      view.close(stale)
    }
    views[session] = view
    val queued = waiting.remove(session) ?: return
    for (call in queued) call(view)
  }

  private fun withView(session: String, call: (PaseoVisualHostView) -> Unit) {
    require(VisualHostProtocol.isSession(session)) { "Invalid visual session" }
    val view = views[session]
    if (view != null) {
      call(view)
      return
    }
    val queue = waiting.getOrPut(session) { ArrayList() }
    check(queue.size < MAX_WAITING_CALLS) { "Visual view for this session was never mounted" }
    while (waiting.size > MAX_WAITING_SESSIONS) {
      val oldest = waiting.keys.first()
      waiting.remove(oldest)
    }
    queue.add(call)
  }

  companion object {
    private const val MAX_WAITING_CALLS = 64
    private const val MAX_WAITING_SESSIONS = 4
  }
}
