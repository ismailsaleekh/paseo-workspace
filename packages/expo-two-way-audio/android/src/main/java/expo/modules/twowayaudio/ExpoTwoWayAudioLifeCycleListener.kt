package expo.modules.twowayaudio

import android.app.Activity
import expo.modules.core.interfaces.ReactActivityLifecycleListener

class ExpoTwoWayAudioLifeCycleListener : ReactActivityLifecycleListener {
    override fun onPause(activity: Activity?) {
        super.onPause(activity)
        val engine = ExpoTwoWayAudioModule.audioEngine ?: return
        // Background recording is not supported. Playback continues only while the user enabled
        // background speech (its foreground service is running).
        if (SpeechPlaybackService.running) {
            engine.pauseRecording()
        } else {
            engine.pauseRecordingAndPlayer()
        }
    }

    override fun onResume(activity: Activity?) {
        super.onResume(activity)
        // At the moment background audio recording and playback is not supported
        ExpoTwoWayAudioModule.audioEngine?.resumeRecordingAndPlayer()
    }
}
