import ExpoModulesCore
import AVFoundation

// The input and player share one voice-processing engine so the loudspeaker
// reference reaches iOS acoustic echo cancellation.
public class MiaVoiceModule: Module {
  private let serial = DispatchQueue(label: "app.mia.voice")
  private var engine: AVAudioEngine?
  private var player: AVAudioPlayerNode?
  private var revision = 0
  private var tapInstalled = false
  private var ownsSession = false
  private var playbackId: String?
  private var playbackPromise: Promise?
  private var observers: [NSObjectProtocol] = []
  private let bridge = MiaAudioBridge()

  public func definition() -> ModuleDefinition {
    Name("MiaVoice")
    Constant("apiVersion") { 2 }
    AsyncFunction("diagnostics") { () -> [String: Any] in
      var report = MiaAudioBridge.diagnostics()
      report["graphPresent"] = self.engine != nil
      report["graphRunning"] = self.engine?.isRunning ?? false
      report["tapInstalled"] = self.tapInstalled
      let session = AVAudioSession.sharedInstance()
      report["sessionCategory"] = session.category.rawValue
      report["sessionMode"] = session.mode.rawValue
      report["inputChannels"] = session.inputNumberOfChannels
      report["sampleRate"] = session.sampleRate
      return report
    }.runOnQueue(serial)
    Events("pcm", "interrupted", "failure")
    AsyncFunction("start") { (promise: Promise) in
      self.serial.async {
        self.revision += 1; let revision = self.revision
        DispatchQueue.main.async {
          AVAudioSession.sharedInstance().requestRecordPermission { granted in
            self.serial.async {
              guard self.revision == revision else { promise.reject("CANCELLED", "Capture was cancelled."); return }
              guard granted else { promise.reject("MICROPHONE_DENIED", "Microphone access is off."); return }
              do { try self.startGraph(revision); promise.resolve() }
              catch { self.stopGraph(); promise.reject("VOICE_START_FAILED", "Voice processing could not start.") }
            }
          }
        }
      }
    }
    AsyncFunction("stop") { self.revision += 1; self.stopGraph() }.runOnQueue(serial)
    AsyncFunction("stopPlayback") { self.cancelPlayback() }.runOnQueue(serial)
    AsyncFunction("play") { (base64: String, id: String, promise: Promise) in
      self.cancelPlayback()
      guard let engine = self.engine, engine.isRunning, let player = self.player,
        let data = Data(base64Encoded: base64), data.count > 0, data.count % 2 == 0, data.count <= 12000000
        else { promise.reject("VOICE_PLAY_FAILED", "Playback is unavailable."); return }
      self.playbackId = id; self.playbackPromise = promise
      let error = MiaAudioBridge.play(data, player: player) { [weak self] in
        self?.serial.async {
          guard let self = self, self.playbackId == id else { return }
          self.playbackId = nil; let done = self.playbackPromise; self.playbackPromise = nil; done?.resolve()
        }
      }
      if let error = error {
        self.playbackId = nil; self.playbackPromise = nil; self.stopGraph(); promise.reject(error)
        self.sendEvent("failure", ["code": "PLAYBACK_FAILED"])
      }
    }.runOnQueue(serial)
    OnCreate {
      self.observers.append(NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: nil) { [weak self] note in
        guard let type = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt, type == AVAudioSession.InterruptionType.began.rawValue else { return }
        self?.interrupt("AUDIO_INTERRUPTED")
      })
      self.observers.append(NotificationCenter.default.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: nil) { [weak self] note in
        guard let reason = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
          reason == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue || reason == AVAudioSession.RouteChangeReason.newDeviceAvailable.rawValue else { return }
        self?.interrupt("AUDIO_ROUTE_CHANGED")
      })
      self.observers.append(NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: nil, queue: nil) { [weak self] note in
        guard let graph = note.object as? AVAudioEngine else { return }
        // AVAudioEngine can stop itself after a hardware format change. Leave
        // its internal notification queue before teardown, and ignore stale
        // notifications or setup notifications for an engine still running.
        self?.serial.async {
          guard let self = self, self.engine === graph, !graph.isRunning else { return }
          if self.playbackId == nil && MiaAudioBridge.resume(graph) == nil { return }
          self.revision += 1; self.stopGraph(); self.sendEvent("interrupted", ["code": "AUDIO_CONFIGURATION_CHANGED"])
        }
      })
      self.observers.append(NotificationCenter.default.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: nil) { [weak self] _ in
        self?.interrupt("AUDIO_SERVICES_RESET")
      })
    }
    OnAppEntersBackground { self.serial.async { self.revision += 1; self.stopGraph() } }
    OnDestroy {
      self.observers.forEach { NotificationCenter.default.removeObserver($0) }; self.observers.removeAll()
      self.serial.async { self.revision += 1; self.stopGraph() }
    }
  }
  private func interrupt(_ code: String) {
    serial.async {
      guard self.engine != nil else { return }
      self.revision += 1; self.stopGraph(); self.sendEvent("interrupted", ["code": code])
    }
  }
  private func startGraph(_ revision: Int) throws {
    stopGraph()
    let session = AVAudioSession.sharedInstance()
    try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetooth])
    try session.setPreferredIOBufferDuration(0.02); try session.setActive(true); ownsSession = true
    let graph = AVAudioEngine(); let output = AVAudioPlayerNode()
    engine = graph; player = output
    tapInstalled = true
    let pendingBuffers = DispatchSemaphore(value: 4)
    let error = MiaAudioBridge.start(graph, player: output) { [weak self] buffer, _ in
      // Never accumulate unbounded retained audio if conversion/event delivery
      // falls behind. The audio callback must not block waiting on our queue.
      guard let self = self, pendingBuffers.wait(timeout: .now()) == .success else { return }
      guard let copy = MiaAudioBridge.copyInput(buffer) else { pendingBuffers.signal(); return }
      self.serial.async {
        defer { pendingBuffers.signal() }
        guard self.revision == revision, self.engine === graph, graph.isRunning else { return }
        self.emitPCM(copy)
      }
    }
    if let error = error { throw error }
  }
  private func emitPCM(_ input: AVAudioPCMBuffer) {
    guard let data = bridge.convert(input) else {
      revision += 1; stopGraph(); sendEvent("failure", ["code": "PCM_CONVERSION_FAILED"]); return
    }
    for offset in stride(from: 0, to: data.count, by: 3840) {
      sendEvent("pcm", ["audio": data.subdata(in: offset..<min(offset + 3840, data.count)).base64EncodedString()])
    }
  }
  private func cancelPlayback() {
    playbackId = nil; _ = MiaAudioBridge.stopPlayback(player); let pending = playbackPromise; playbackPromise = nil
    pending?.reject("CANCELLED", "Playback was interrupted.")
  }
  private func stopGraph() {
    cancelPlayback()
    _ = MiaAudioBridge.stop(engine, player: player, tapped: tapInstalled)
    tapInstalled = false; player = nil; engine = nil; bridge.reset()
    if ownsSession { ownsSession = false; try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
  }
}
