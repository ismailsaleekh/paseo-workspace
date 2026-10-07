package sh.paseo.visualhost

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log

/** Log-only watchdog. Neither document text nor bridge payloads enter diagnostics. */
class MainThreadWatchdog {
  private val main = Handler(Looper.getMainLooper())
  private val mainThread = Looper.getMainLooper().thread
  private val lock = Any()
  @Volatile private var running = false
  @Volatile private var operation = "idle"
  private var dispatchSince = 0L
  private var pendingSince = 0L
  private var lastReport = 0L
  private var sampledOperation = "idle"
  private var sampledStack = emptyArray<StackTraceElement>()
  private val worker = Thread({ monitor() }, "visual-main-watchdog").apply { isDaemon = true }

  fun start() {
    running = true
    // Dispatch timing catches even a 1000 ms stall between two heartbeat samples.
    Looper.getMainLooper().setMessageLogging { line ->
      synchronized(lock) {
        if (line.startsWith(">>>>>")) {
          dispatchSince = SystemClock.uptimeMillis()
        } else if (line.startsWith("<<<<<")) {
          val elapsed = SystemClock.uptimeMillis() - dispatchSince
          if (dispatchSince != 0L && elapsed >= 1_000L) report(elapsed)
          dispatchSince = 0L
          lastReport = 0L
        }
      }
    }
    worker.start()
  }

  fun stop() {
    running = false
    Looper.getMainLooper().setMessageLogging(null)
    worker.interrupt()
  }

  fun <T> during(name: String, work: () -> T): T {
    val previous = operation
    operation = name
    try {
      return work()
    } finally {
      operation = previous
    }
  }

  private fun report(elapsed: Long) {
    Log.w("PaseoVisualHost", "main thread stalled $elapsed ms during $sampledOperation")
    val frames = if (sampledStack.isEmpty()) mainThread.stackTrace else sampledStack
    for (frame in frames.take(12)) Log.w("PaseoVisualHost", "  at $frame")
  }

  private fun monitor() {
    while (running) {
      synchronized(lock) {
        val now = SystemClock.uptimeMillis()
        if (pendingSince == 0L) {
          pendingSince = now
          main.post {
            synchronized(lock) {
              val elapsed = SystemClock.uptimeMillis() - pendingSince
              if (elapsed >= 1_000L) report(elapsed)
              pendingSince = 0L
            }
          }
        }
        val started = if (dispatchSince != 0L) dispatchSince else pendingSince
        if (now - started >= 100L) {
          sampledStack = mainThread.stackTrace
          sampledOperation = operation
        }
        if (now - started >= 1_000L && now - lastReport >= 1_000L) {
          lastReport = now
          report(now - started)
        }
      }
      VisualHostDebugFaults.poll(main)
      try {
        Thread.sleep(100L)
      } catch (error: InterruptedException) {
        if (running) Log.e("PaseoVisualHost", "Main-thread watchdog was interrupted unexpectedly")
      }
    }
  }
}
