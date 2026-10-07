package sh.paseo.visualhost

import android.os.Handler
import android.util.Log

/** No system-property read is reachable in the production application variant. */
object VisualHostDebugFaults {
  private var previousBlock = ""
  private var readFailureReported = false

  private fun property(name: String): String {
    if (!BuildConfig.DEVELOPMENT_FAULTS) return ""
    return try {
      val properties = Class.forName("android.os.SystemProperties")
      properties.getMethod("get", String::class.java).invoke(null, name) as String
    } catch (error: ReflectiveOperationException) {
      if (!readFailureReported) {
        readFailureReported = true
        Log.e("PaseoVisualHost", "Debug property access failed: ${error.javaClass.simpleName}")
      }
      ""
    }
  }

  private fun delay(value: String): Long = value.toLongOrNull()?.takeIf { it in 1L..20_000L } ?: 0L

  fun beforeTerminate() {
    if (!BuildConfig.DEVELOPMENT_FAULTS) return
    val milliseconds = delay(property("debug.paseo.visualhost.slow_renderer_ms"))
    if (milliseconds == 0L) return
    Log.i("PaseoVisualHost", "debug slow renderer: terminate delayed $milliseconds ms on thread ${Thread.currentThread().name}")
    Thread.sleep(milliseconds)
  }

  /** Called by the off-main watchdog, so detection continues while the main thread is blocked. */
  fun poll(main: Handler) {
    if (!BuildConfig.DEVELOPMENT_FAULTS) return
    val value = property("debug.paseo.visualhost.block_main_ms")
    if (value == previousBlock) return
    previousBlock = value
    val milliseconds = delay(value)
    if (milliseconds == 0L) return
    main.post {
      Log.i("PaseoVisualHost", "debug block main: $milliseconds ms")
      Thread.sleep(milliseconds)
    }
  }
}
