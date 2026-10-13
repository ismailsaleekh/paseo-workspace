package expo.modules.twowayaudio

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

/**
 * User-enabled background speech: a media-playback foreground service with an ongoing
 * notification. Its headless JS task keeps the JS timers that pace speech playback running while
 * the app is in the background, and the notification's action stops the current speech.
 */
class SpeechPlaybackService : HeadlessJsTaskService() {
    companion object {
        const val TASK_KEY = "ExpoTwoWayAudioBackgroundPlayback"
        private const val ACTION_STOP_SPEECH = "expo.modules.twowayaudio.action.STOP_SPEECH"
        private const val CHANNEL_ID = "speech-playback"
        private const val NOTIFICATION_ID = 24165

        @Volatile
        var running = false
            private set

        /** Set while the module is alive; runs when the user taps the notification's Stop. */
        @Volatile
        var onStopSpeech: (() -> Unit)? = null

        /** Must be called while the app is in the foreground (Android 12+ rule). */
        fun start(context: Context) {
            ContextCompat.startForegroundService(context, Intent(context, SpeechPlaybackService::class.java))
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, SpeechPlaybackService::class.java))
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP_SPEECH) {
            onStopSpeech?.invoke()
            return START_NOT_STICKY
        }
        startInForeground()
        if (!running) {
            running = true
            super.onStartCommand(intent, flags, startId)
        }
        // A killed app cannot play speech; the user enables background speech again in the app.
        return START_NOT_STICKY
    }

    override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig =
        HeadlessJsTaskConfig(TASK_KEY, Arguments.createMap(), 0, true)

    override fun onDestroy() {
        running = false
        super.onDestroy()
    }

    private fun startInForeground() {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Speech playback", NotificationManager.IMPORTANCE_LOW)
            )
        }
        val flags = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        val stop = PendingIntent.getService(
            this,
            0,
            Intent(this, SpeechPlaybackService::class.java).setAction(ACTION_STOP_SPEECH),
            flags
        )
        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle("Paseo voice")
            .setContentText("Speech keeps playing while Paseo is in the background")
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .addAction(android.R.drawable.ic_media_pause, "Stop speaking", stop)
        packageManager.getLaunchIntentForPackage(packageName)?.let { launch ->
            builder.setContentIntent(PendingIntent.getActivity(this, 0, launch, flags))
        }
        val notification = builder.build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }
}
