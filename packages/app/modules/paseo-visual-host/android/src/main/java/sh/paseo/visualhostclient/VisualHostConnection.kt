package sh.paseo.visualhostclient

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Message
import android.os.Messenger
import android.os.RemoteException

/**
 * One binding to `<this app's id>.visualhost`. The service is protected by a signature-level
 * permission that both apps declare, so only the same-signature companion can answer. Every
 * failure is reported once through [Listener.onUnavailable]; the binding is then released.
 */
class VisualHostConnection(context: Context, private val listener: Listener) : ServiceConnection {
  interface Listener {
    fun onConnected()
    fun onUnavailable(message: String)
    fun onHostMessage(message: Message)
  }

  private val context: Context = context.applicationContext
  private val handler = Handler(Looper.getMainLooper())
  private val replies = Messenger(object : Handler(Looper.getMainLooper()) {
    override fun handleMessage(msg: Message) {
      if (!released) listener.onHostMessage(msg)
    }
  })
  private val timeout = Runnable { fail("The Paseo visual host did not respond") }
  private var service: Messenger? = null
  private var bound = false
  private var released = false

  val connected: Boolean
    get() = service != null && !released

  /** Returns false (after reporting) when the visual host is missing or refuses this app. */
  fun bind(): Boolean {
    val target = ComponentName(
      context.packageName + VisualHostProtocol.SERVICE_SUFFIX,
      VisualHostProtocol.SERVICE_CLASS,
    )
    val intent = Intent().setComponent(target)
    val accepted = try {
      context.bindService(intent, this, Context.BIND_AUTO_CREATE)
    } catch (error: SecurityException) {
      fail("The Paseo visual host is not signed with this app's key")
      return false
    }
    // Even a refused bindService registers the connection; it must be unbound.
    bound = true
    if (!accepted) {
      fail("The Paseo visual host app is not installed")
      return false
    }
    handler.postDelayed(timeout, BIND_TIMEOUT_MS)
    return true
  }

  fun send(what: Int, data: Bundle): Boolean {
    val target = service ?: return false
    val message = Message.obtain(null, what)
    message.data = data
    message.replyTo = replies
    return try {
      target.send(message)
      true
    } catch (error: RemoteException) {
      fail("The Paseo visual host stopped")
      false
    }
  }

  override fun onServiceConnected(name: ComponentName, binder: IBinder) {
    if (released) return
    handler.removeCallbacks(timeout)
    service = Messenger(binder)
    listener.onConnected()
  }

  override fun onServiceDisconnected(name: ComponentName) {
    fail("The Paseo visual host stopped")
  }

  override fun onBindingDied(name: ComponentName) {
    fail("The Paseo visual host was removed or replaced")
  }

  override fun onNullBinding(name: ComponentName) {
    fail("The Paseo visual host refused the connection")
  }

  fun release() {
    if (released) return
    released = true
    handler.removeCallbacks(timeout)
    service = null
    if (bound) {
      bound = false
      context.unbindService(this)
    }
  }

  private fun fail(message: String) {
    if (released) return
    release()
    listener.onUnavailable(message)
  }

  companion object {
    private const val BIND_TIMEOUT_MS = 8_000L
  }
}
