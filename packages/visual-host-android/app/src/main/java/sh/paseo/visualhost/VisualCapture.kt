package sh.paseo.visualhost

import android.graphics.Bitmap
import android.graphics.HardwareRenderer
import android.graphics.PixelFormat
import android.graphics.RenderNode
import android.hardware.HardwareBuffer
import android.media.ImageReader
import android.webkit.WebView
import java.io.ByteArrayOutputStream

class CapturedFrame(val png: ByteArray, val width: Int, val height: Int, val density: Float)

/**
 * Hardware capture of the live displayed document: the same WebView instance is recorded into a
 * RenderNode and rendered offscreen by HardwareRenderer into an ImageReader (WebGL included).
 * Paseo's own PixelCopy cannot see the embedded surface, and a software draw is unreliable.
 */
object VisualCapture {
  fun capture(web: WebView): CapturedFrame {
    val width = web.width
    val height = web.height
    if (width <= 0 || height <= 0) throw VisualHostException(VisualHostProtocol.CAPTURE_FAILED, "The visual has no visible size")
    if (width > VisualHostProtocol.MAX_CAPTURE_DIMENSION || height > VisualHostProtocol.MAX_CAPTURE_DIMENSION) {
      throw VisualHostException(VisualHostProtocol.CAPTURE_FAILED, "The visual exceeds the capture dimension bound")
    }
    val reader = ImageReader.newInstance(
      width,
      height,
      PixelFormat.RGBA_8888,
      2,
      HardwareBuffer.USAGE_GPU_COLOR_OUTPUT or HardwareBuffer.USAGE_CPU_READ_OFTEN,
    )
    val renderer = HardwareRenderer()
    try {
      renderer.setSurface(reader.surface)
      val node = RenderNode("paseo-visual-capture")
      node.setPosition(0, 0, width, height)
      val canvas = node.beginRecording(width, height)
      try {
        web.draw(canvas)
      } finally {
        node.endRecording()
      }
      renderer.setContentRoot(node)
      renderer.createRenderRequest().setWaitForPresent(true).syncAndDraw()
      val image = reader.acquireLatestImage()
        ?: throw VisualHostException(VisualHostProtocol.CAPTURE_FAILED, "The renderer produced no frame")
      val frame = try {
        val plane = image.planes[0]
        val rowPixels = plane.rowStride / plane.pixelStride
        val full = Bitmap.createBitmap(rowPixels, height, Bitmap.Config.ARGB_8888)
        full.copyPixelsFromBuffer(plane.buffer)
        if (rowPixels == width) full else Bitmap.createBitmap(full, 0, 0, width, height)
      } finally {
        image.close()
      }
      val output = ByteArrayOutputStream()
      if (!frame.compress(Bitmap.CompressFormat.PNG, 100, output)) {
        throw VisualHostException(VisualHostProtocol.CAPTURE_FAILED, "The frame could not be encoded")
      }
      val png = output.toByteArray()
      if (png.size > VisualHostProtocol.MAX_CAPTURE_BYTES) {
        throw VisualHostException(VisualHostProtocol.CAPTURE_FAILED, "The capture exceeds its byte bound")
      }
      return CapturedFrame(png, width, height, web.resources.displayMetrics.density)
    } finally {
      renderer.destroy()
      reader.close()
    }
  }
}
