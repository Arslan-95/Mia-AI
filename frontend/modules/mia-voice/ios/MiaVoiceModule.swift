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
  private var playbackRevision = 0
  private var playbackPromise: Promise?
  private var observers: [NSObjectProtocol] = []
  private var graphEpoch = 0
  private enum GraphPhase: String { case idle, starting, running, stopping }
  private var graphPhase: GraphPhase = .idle
  private var pendingStart: Promise?
  private var inputReceived = false
  private let bridge = MiaAudioBridge()

  public func definition() -> ModuleDefinition {
    Name("MiaVoice")
    Constant("apiVersion") { 3 }
    AsyncFunction("diagnostics") { () -> [String: Any] in
      var report = MiaAudioBridge.diagnostics()
      report["graphPresent"] = self.engine != nil
      report["graphRunning"] = self.engine?.isRunning ?? false
      report["graphEpoch"] = self.graphEpoch
      report["graphPhase"] = self.graphPhase.rawValue
      report["tapInstalled"] = self.tapInstalled
      report["inputReceived"] = self.inputReceived
      report["voiceProcessing"] = self.engine?.inputNode.isVoiceProcessingEnabled ?? false
      report["voiceProcessingBypassed"] = self.engine?.inputNode.isVoiceProcessingBypassed ?? false
      report["inputMuted"] = self.engine?.inputNode.isVoiceProcessingInputMuted ?? false
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
        self.stopGraph()
        DispatchQueue.main.async {
          AVAudioSession.sharedInstance().requestRecordPermission { granted in
            self.serial.async {
              guard self.revision == revision else { promise.reject("CANCELLED", "Capture was cancelled."); return }
              guard granted else { promise.reject("MICROPHONE_DENIED", "Microphone access is off."); return }
              do {
                self.pendingStart = promise
                try self.startGraph(revision)
                self.checkStarted(self.graphEpoch, attempts: 40)
              }
              catch { self.pendingStart = nil; self.stopGraph(); promise.reject("VOICE_START_FAILED", "Voice processing could not start.") }
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
      let epoch = self.graphEpoch; let playbackRevision = self.playbackRevision
      let error = MiaAudioBridge.play(data, player: player) { [weak self] in
        self?.serial.async { [weak self] in
          guard let self = self, self.graphEpoch == epoch,
            self.playbackRevision == playbackRevision, self.playbackId == id else { return }
          self.playbackId = nil; let done = self.playbackPromise; self.playbackPromise = nil; done?.resolve()
        }
      }
      if let error = error {
        self.playbackId = nil; self.playbackPromise = nil; self.stopGraph(); promise.reject(error)
        self.sendEvent("failure", ["code": "PLAYBACK_FAILED"])
      }
    }.runOnQueue(serial)
    OnAppEntersBackground { self.serial.async { self.revision += 1; self.stopGraph() } }
    OnDestroy { self.serial.async { self.revision += 1; self.stopGraph() } }
  }
  private func observeGraph(_ graph: AVAudioEngine, epoch: Int) {
      observers.append(NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: nil) { [weak self] note in
        guard let type = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt, type == AVAudioSession.InterruptionType.began.rawValue else { return }
        self?.interrupt("AUDIO_INTERRUPTED", epoch: epoch)
      })
      observers.append(NotificationCenter.default.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: nil) { [weak self] note in
        guard let reason = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
          reason == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue || reason == AVAudioSession.RouteChangeReason.newDeviceAvailable.rawValue else { return }
        self?.interrupt("AUDIO_ROUTE_CHANGED", epoch: epoch)
      })
      observers.append(NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: graph, queue: nil) { [weak self] _ in
        // Never read, cast, capture or retain notification.object. It may be
        // the engine currently being destroyed. Only the scalar epoch crosses
        // this callback; the live engine is acquired on its owner queue.
        self?.serial.async { [weak self] in
          guard let self = self, self.graphEpoch == epoch,
            self.graphPhase == .running || self.graphPhase == .starting,
            let current = self.engine, !current.isRunning else { return }
          if self.playbackId == nil && MiaAudioBridge.resume(current) == nil { return }
          self.revision += 1; self.stopGraph(); self.sendEvent("interrupted", ["code": "AUDIO_CONFIGURATION_CHANGED"])
        }
      })
      observers.append(NotificationCenter.default.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: nil) { [weak self] _ in
        self?.interrupt("AUDIO_SERVICES_RESET", epoch: epoch)
      })
  }
  private func interrupt(_ code: String, epoch: Int) {
    serial.async {
      guard self.graphEpoch == epoch, self.engine != nil else { return }
      self.revision += 1; self.stopGraph(); self.sendEvent("interrupted", ["code": code])
    }
  }
  private func startGraph(_ revision: Int) throws {
    graphPhase = .starting
    let session = AVAudioSession.sharedInstance()
    try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetooth])
    try session.setPreferredIOBufferDuration(0.02); try session.setActive(true); ownsSession = true
    let graph = AVAudioEngine(); let output = AVAudioPlayerNode()
    engine = graph; player = output
    let epoch = graphEpoch
    observeGraph(graph, epoch: epoch)
    tapInstalled = true
    let pendingBuffers = DispatchSemaphore(value: 4)
    let error = MiaAudioBridge.start(graph, player: output) { [weak self] buffer, _ in
      // Never accumulate unbounded retained audio if conversion/event delivery
      // falls behind. The audio callback must not block waiting on our queue.
      guard let self = self, pendingBuffers.wait(timeout: .now()) == .success else { return }
      guard let copy = MiaAudioBridge.copyInput(buffer) else { pendingBuffers.signal(); return }
      self.serial.async {
        defer { pendingBuffers.signal() }
        guard self.revision == revision, self.graphEpoch == epoch,
          self.graphPhase == .running || self.graphPhase == .starting,
          self.engine?.isRunning == true else { return }
        self.inputReceived = true
        self.emitPCM(copy)
      }
    }
    if let error = error { throw error }
  }
  private func checkStarted(_ epoch: Int, attempts: Int) {
    guard graphEpoch == epoch, graphPhase == .starting, let graph = engine else { return }
    // A running flag alone does not establish that VPIO delivers input.
    // Wait for a copied input buffer too; all retries are epoch-fenced.
    if graph.isRunning && inputReceived {
      MiaAudioBridge.record("capture_ready", detail: ["epoch": epoch])
      graphPhase = .running; let ready = pendingStart; pendingStart = nil; ready?.resolve(); return
    }
    guard attempts > 0 else {
      let failed = pendingStart; pendingStart = nil; stopGraph()
      failed?.reject("VOICE_START_FAILED", "Voice processing could not start."); return
    }
    if !graph.isRunning { _ = MiaAudioBridge.resume(graph) }
    serial.asyncAfter(deadline: .now() + 0.05) { [weak self] in self?.checkStarted(epoch, attempts: attempts - 1) }
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
    playbackRevision += 1; playbackId = nil
    _ = MiaAudioBridge.stopPlayback(player); let pending = playbackPromise; playbackPromise = nil
    pending?.reject("CANCELLED", "Playback was interrupted.")
  }
  private func stopGraph() {
    // Revoke callbacks BEFORE any AVFoundation operation can post another
    // configuration notification. No queued callback owns the retired graph.
    graphPhase = .stopping; graphEpoch += 1
    if engine != nil { MiaAudioBridge.record("graph_retiring", detail: ["epoch": graphEpoch - 1]) }
    observers.forEach { NotificationCenter.default.removeObserver($0) }; observers.removeAll()
    let starting = pendingStart; pendingStart = nil
    starting?.reject("CANCELLED", "Capture was cancelled.")
    cancelPlayback()
    _ = MiaAudioBridge.stop(engine, player: player, tapped: tapInstalled)
    tapInstalled = false; inputReceived = false; player = nil; engine = nil; bridge.reset()
    if ownsSession { ownsSession = false; try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
    graphPhase = .idle
  }
}
