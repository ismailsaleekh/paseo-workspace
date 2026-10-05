package sh.paseo.visualhost

import android.annotation.SuppressLint
import android.net.Uri
import android.net.http.SslError
import android.os.Message
import android.view.MotionEvent
import android.webkit.GeolocationPermissions
import android.webkit.HttpAuthHandler
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import java.io.ByteArrayInputStream
import java.util.concurrent.atomic.AtomicBoolean

/** What a contained document may tell its session. Everything else is refused by policy. */
interface DocumentEvents {
  fun onPageReady()
  fun onDocumentMessage(text: String)
  fun onActivity()
  fun onRendererGone(crashed: Boolean)
}

/**
 * Policy installed on every visual WebView before anything loads, independent of generated
 * script: the document is served only from the synthetic origin through interception with a
 * header CSP, every other request is refused, and navigation, windows, downloads, file and
 * content access, geolocation, dialogs and every permission request are denied.
 */
object VisualDocumentPolicy {
  private const val CSP =
    "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' data: blob:; " +
      "style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; " +
      "frame-src 'self' data: blob:; connect-src 'none'; worker-src 'none'; object-src 'none'; " +
      "base-uri 'none'; form-action 'none'"

  @SuppressLint("SetJavaScriptEnabled", "ClickableViewAccessibility")
  fun install(web: WebView, document: ByteArray, events: DocumentEvents) {
    val settings = web.settings
    settings.javaScriptEnabled = true
    settings.javaScriptCanOpenWindowsAutomatically = false
    settings.setSupportMultipleWindows(true)
    settings.domStorageEnabled = false
    settings.allowFileAccess = false
    settings.allowContentAccess = false
    settings.setGeolocationEnabled(false)
    settings.mediaPlaybackRequiresUserGesture = true
    settings.cacheMode = WebSettings.LOAD_NO_CACHE
    settings.safeBrowsingEnabled = false
    settings.builtInZoomControls = false
    web.webViewClient = DocumentClient(document, events)
    web.webChromeClient = DeniedChrome()
    // Downloads are refused: the listener never starts one.
    web.setDownloadListener { _, _, _, _, _ -> }
    web.setOnTouchListener { _, event ->
      if (event.actionMasked == MotionEvent.ACTION_DOWN) events.onActivity()
      false
    }
    WebViewCompat.addWebMessageListener(
      web,
      VisualHostProtocol.BRIDGE_OBJECT,
      setOf(VisualHostProtocol.DOCUMENT_ORIGIN),
      object : WebViewCompat.WebMessageListener {
        override fun onPostMessage(
          view: WebView,
          message: WebMessageCompat,
          sourceOrigin: Uri,
          isMainFrame: Boolean,
          replyProxy: JavaScriptReplyProxy,
        ) {
          // Only the top-level document speaks for the visual; child realms are not trusted with
          // the bridge even when they share its origin.
          if (!isMainFrame) return
          val text = message.data ?: return
          events.onDocumentMessage(text)
        }
      },
    )
  }

  private class DocumentClient(
    private val document: ByteArray,
    private val events: DocumentEvents,
  ) : WebViewClient() {
    private val served = AtomicBoolean(false)

    override fun shouldInterceptRequest(
      view: WebView,
      request: WebResourceRequest,
    ): WebResourceResponse {
      val isDocument =
        request.isForMainFrame &&
          request.method == "GET" &&
          request.url.toString() == VisualHostProtocol.DOCUMENT_URL
      // The document is served exactly once; reloads and every other request are refused.
      if (isDocument && served.compareAndSet(false, true)) {
        return WebResourceResponse(
          "text/html",
          "utf-8",
          200,
          "OK",
          mapOf(
            "Content-Security-Policy" to CSP,
            "Cache-Control" to "no-store",
            "X-Content-Type-Options" to "nosniff",
            "Referrer-Policy" to "no-referrer",
          ),
          ByteArrayInputStream(document),
        )
      }
      return WebResourceResponse(
        "text/plain",
        "utf-8",
        403,
        "Refused",
        mapOf("Cache-Control" to "no-store"),
        ByteArrayInputStream(ByteArray(0)),
      )
    }

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = true

    override fun onPageFinished(view: WebView, url: String) {
      if (url == VisualHostProtocol.DOCUMENT_URL) events.onPageReady()
    }

    override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
      events.onRendererGone(detail.didCrash())
      return true
    }

    override fun onReceivedHttpAuthRequest(
      view: WebView,
      handler: HttpAuthHandler,
      host: String,
      realm: String,
    ) {
      handler.cancel()
    }

    @SuppressLint("WebViewClientOnReceivedSslError")
    override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
      handler.cancel()
    }
  }

  private class DeniedChrome : WebChromeClient() {
    override fun onPermissionRequest(request: PermissionRequest) {
      request.deny()
    }

    override fun onGeolocationPermissionsShowPrompt(
      origin: String,
      callback: GeolocationPermissions.Callback,
    ) {
      callback.invoke(origin, false, false)
    }

    override fun onCreateWindow(
      view: WebView,
      isDialog: Boolean,
      isUserGesture: Boolean,
      resultMsg: Message,
    ): Boolean = false

    // Not handled: the WebView then opens no chooser, so file inputs stay empty.
    override fun onShowFileChooser(
      webView: WebView,
      filePathCallback: ValueCallback<Array<Uri>>,
      fileChooserParams: FileChooserParams,
    ): Boolean = false

    override fun onJsAlert(view: WebView, url: String, message: String, result: JsResult): Boolean {
      result.cancel()
      return true
    }

    override fun onJsConfirm(view: WebView, url: String, message: String, result: JsResult): Boolean {
      result.cancel()
      return true
    }

    override fun onJsPrompt(
      view: WebView,
      url: String,
      message: String,
      defaultValue: String,
      result: JsPromptResult,
    ): Boolean {
      result.cancel()
      return true
    }

    override fun onJsBeforeUnload(
      view: WebView,
      url: String,
      message: String,
      result: JsResult,
    ): Boolean {
      result.cancel()
      return true
    }
  }
}
