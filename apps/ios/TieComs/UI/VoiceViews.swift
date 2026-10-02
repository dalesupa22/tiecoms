import AVFoundation
import SwiftUI
import UIKit

/// Onda de una nota de voz; la parte reproducida se pinta más fuerte. Tocar o arrastrar mueve la reproducción.
struct Waveform: View {
    var values: [Double]
    var progress: Double
    var tint: Color
    var onSeek: ((Double) -> Void)? = nil

    var body: some View {
        GeometryReader { g in
            let bars = values.isEmpty ? Array(repeating: 0.25, count: 32) : values
            let w = g.size.width / CGFloat(bars.count)
            HStack(alignment: .center, spacing: 0) {
                ForEach(Array(bars.enumerated()), id: \.offset) { i, v in
                    Capsule()
                        .fill(Double(i) / Double(bars.count) < progress ? tint : tint.opacity(0.35))
                        .frame(width: max(1.5, w * 0.6), height: max(3, g.size.height * CGFloat(v)))
                        .frame(width: w)
                }
            }
            .frame(maxHeight: .infinity)
            .contentShape(Rectangle())
            .gesture(DragGesture(minimumDistance: 0).onChanged { v in onSeek?(min(1, max(0, v.location.x / g.size.width))) })
        }
    }
}

/// Burbuja de voz: play/pausa, onda, duración, velocidad, «Sin escuchar», transcripción plegable, resumen y chip «Crear asunto».
struct VoiceNoteView: View {
    @Environment(AppStore.self) private var store
    let att: AttachmentDTO
    var mine: Bool
    var conversationId: String?
    var messageId: String?
    var authorIsMe = false
    @State private var showTranscript = false
    @State private var creatingIssue = false
    @State private var retrying = false
    @State private var showingAIConsent = false

    private var player: VoicePlayer { VoicePlayer.shared }

    var body: some View {
        let isCurrent = player.currentId == att.id
        let fg: Color = mine ? .white : Theme.textPrimary
        let tint: Color = mine ? .white : Theme.accentText
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                Button { Task { guard !store.callCenter.inCall else { store.show(L("voice.callBusy")); return }; await player.toggle(att, api: store.api); if let error = player.lastError { store.show(error) } } } label: {
                    Image(systemName: isCurrent && player.playing ? "pause.fill" : "play.fill")
                        .font(.system(size: 16, weight: .bold))
                        .foregroundStyle(mine ? Theme.bubbleMine : .white)
                        .frame(width: 36, height: 36)
                        .background(Circle().fill(mine ? Color.white : Theme.bubbleMine))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(isCurrent && player.playing ? L("voice.pause") : L("voice.play"))
                .accessibilityIdentifier("voice.play.\(att.id)")
                Waveform(values: att.waveform ?? [], progress: isCurrent ? player.progress : 0, tint: tint) { f in
                    // Tocar la onda de una nota que no suena la empieza en ese punto.
                    if player.currentId == att.id { player.seek(att, to: f) } else { Task { guard !store.callCenter.inCall else { store.show(L("voice.callBusy")); return }; await player.toggle(att, api: store.api); player.seek(att, to: f); if let error = player.lastError { store.show(error) } } }
                }
                    .frame(width: 150, height: 30)
                    .accessibilityHidden(true)
                VStack(alignment: .trailing, spacing: 2) {
                    Text(L10n.duration(isCurrent ? Int(player.progress * Double(att.durationMs ?? 0)) : att.durationMs ?? 0))
                        .font(.caption.monospacedDigit()).foregroundStyle(fg.opacity(0.85))
                    if isCurrent {
                        Button { player.cycleRate() } label: {
                            Text(player.rate == 1 ? "1×" : player.rate == 1.5 ? "1.5×" : "2×").font(.caption2.weight(.bold))
                                .padding(.horizontal, 6).padding(.vertical, 1)
                                .background(Capsule().fill(fg.opacity(0.18)))
                                .foregroundStyle(fg)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(L("voice.speed"))
                        .accessibilityIdentifier("voice.speed")
                    } else if !authorIsMe && !player.heard.contains(att.id) {
                        Circle().fill(Theme.orange).frame(width: 7, height: 7).accessibilityLabel(L("voice.unheard"))
                    }
                }
            }
            transcriptArea(fg: fg)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("voice.note.\(att.id)")
        .alert(L("ai.voice.title"), isPresented: $showingAIConsent) {
            Button(L("ai.voice.retry")) { retry() }
            Button(L("common.cancel"), role: .cancel) {}
        } message: { Text(L("ai.voice.message")) }
    }

    @ViewBuilder private func transcriptArea(fg: Color) -> some View {
        if let t = att.transcript {
            switch t.status {
            case .pending:
                Label(L("voice.transcribing"), systemImage: "waveform").font(.caption).foregroundStyle(fg.opacity(0.8))
            case .failed:
                HStack(spacing: 8) {
                    Text(L("voice.failed")).font(.caption).foregroundStyle(fg.opacity(0.8))
                    Button(L("voice.retry")) { showingAIConsent = true }.font(.caption.weight(.semibold)).foregroundStyle(mine ? .white : Theme.accentText).disabled(retrying)
                }
            case .disabled:
                Text(L("voice.disabled")).font(.caption).foregroundStyle(fg.opacity(0.7)).accessibilityIdentifier("voice.disabled")
            case .done:
                if let text = t.text, !text.isEmpty {
                    if let s = t.summary, !s.isEmpty {
                        Text("\(L("voice.summary")): \(s)").font(.caption.weight(.semibold)).foregroundStyle(fg)
                    }
                    Button { withAnimation(.easeInOut(duration: 0.2)) { showTranscript.toggle() } } label: {
                        Label(showTranscript ? L("voice.hideTranscript") : L("voice.showTranscript"), systemImage: "text.quote")
                            .font(.caption.weight(.semibold))
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(mine ? .white : Theme.accentText)
                    .accessibilityIdentifier("voice.transcriptToggle")
                    if showTranscript {
                        Text(text).font(.subheadline).foregroundStyle(fg).textSelection(.enabled)
                            .contextMenu {
                                Button { UIPasteboard.general.string = text; store.show(L("voice.copied")) } label: { Label(L("voice.copy"), systemImage: "doc.on.doc") }
                            }
                            .accessibilityIdentifier("voice.transcript")
                    }
                }
                if let issue = t.suggestedIssue, !issue.isEmpty, let cid = conversationId, !store.isGuest(cid) {
                    Button { createIssue(issue) } label: {
                        Label(L("voice.createIssue", ["title": issue]), systemImage: "checklist")
                            .font(.caption.weight(.semibold)).lineLimit(2).multilineTextAlignment(.leading)
                            .padding(.horizontal, 10).padding(.vertical, 5)
                            .background(Capsule().fill(mine ? Color.white.opacity(0.2) : Theme.orange.opacity(0.14)))
                            .foregroundStyle(mine ? .white : Theme.accentText)
                    }
                    .buttonStyle(.plain)
                    .disabled(creatingIssue)
                    .accessibilityIdentifier("voice.createIssue")
                }
            }
        }
    }

    private func retry() {
        retrying = true
        Task {
            do { try await store.api.retryTranscription(att.id, aiConsent: true) } catch let e as ApiRequestError where e.code == "transcription_disabled" {
                store.show(L("voice.disabled"))
            } catch { store.show(L10n.errorText(error)) }
            retrying = false
        }
    }

    private func createIssue(_ title: String) {
        guard let conversationId else { return }
        creatingIssue = true
        Task {
            do {
                let i = try await store.createIssue(conversationId: conversationId, title: title, ownerId: store.me?.id, dueDate: nil, originMessageId: messageId)
                store.show(i.title)
            } catch { store.show(L10n.errorText(error)) }
            creatingIssue = false
        }
    }
}

/// One touch owns one attempt. Release finishes a local preview; sending is always explicit.
struct VoiceRecordButton: View {
    @Environment(AppStore.self) private var store
    let recorder: VoiceRecorder
    var onSend: (Data, Int, [Double]) -> Void
    @State private var drag: CGSize = .zero
    @State private var touchOpen = false
    @State private var attempt: UUID?
    @State private var terminal = false
    @State private var denied = false
    static let cancelDistance: CGFloat = 110
    static let lockDistance: CGFloat = 80
    var body: some View {
        Image(systemName: "mic.fill")
            .font(.system(size: 18, weight: .semibold)).foregroundStyle(.white)
            .frame(width: 44, height: 44).background(Circle().fill(touchOpen ? Theme.orange : Theme.bubbleMine))
            .scaleEffect(touchOpen && !terminal ? 1.2 : 1)
            .gesture(DragGesture(minimumDistance: 0)
                .onChanged { value in
                    if !touchOpen { touchOpen = true; terminal = false; begin() }
                    guard !terminal else { return }
                    drag = value.translation
                    if value.translation.width < -Self.cancelDistance {
                        terminal = true; attempt = nil; recorder.cancel(); store.show(L("voice.cancelled")); Haptics.tap()
                    } else if value.translation.height < -Self.lockDistance, recorder.state == .recording {
                        terminal = true; recorder.lock(); Haptics.tap()
                    }
                }
                .onEnded { _ in
                    attempt = nil; touchOpen = false; drag = .zero
                    if !terminal, recorder.state == .recording { finishPreview() }
                    terminal = false
                })
            .accessibilityLabel(L("voice.hold"))
            .accessibilityHint(L("voice.previewHint"))
            .accessibilityAddTraits(.isButton)
            .accessibilityAction { begin(accessible: true) }
            .accessibilityIdentifier("composer.mic")
            .onDisappear { attempt = nil; touchOpen = false }
            .onReceive(NotificationCenter.default.publisher(for: UIApplication.willResignActiveNotification)) { _ in
                // The first permission prompt or an interrupted gesture must never start recording after release.
                if recorder.state == .idle { attempt = nil; touchOpen = false; terminal = true }
            }
            .alert(L("voice.micDenied"), isPresented: $denied) {
                Button(L("common.close"), role: .cancel) {}
                Button(L("settings.nav")) { if let u = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(u) } }
            }
    }
    private func begin(accessible: Bool = false) {
        guard recorder.state == .idle, !store.callCenter.inCall else { terminal = true; store.show(L("voice.callBusy")); return }
        let id = UUID(), stamp = store.sessionStamp; attempt = id
        Task {
            let allowed = await VoiceRecorder.requestPermission()
            guard stamp == store.sessionStamp, attempt == id, accessible || (touchOpen && !terminal) else { return }
            guard allowed else { attempt = nil; terminal = true; denied = true; return }
            guard !store.callCenter.inCall else { attempt = nil; terminal = true; store.show(L("voice.callBusy")); return }
            VoicePlayer.shared.stop()
            do {
                try recorder.start()
                if accessible { recorder.lock(); attempt = nil }
                UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            } catch { attempt = nil; terminal = true; store.show(L("voice.micUnavailable")) }
        }
    }
    private func finishPreview() {
        switch recorder.finishOutcome() {
        case .success(let clip): Haptics.tap(); onSend(clip.data, clip.durationMs, clip.waveform)
        case .failure(let error): store.show(error == .tooShort ? L("voice.tooShort") : L("voice.unreadable"))
        }
    }
}

struct LocalVoicePreview: View {
    @Environment(AppStore.self) private var store
    let data: Data
    let durationMs: Int
    let waveform: [Double]
    var onDiscard: () -> Void
    var onSend: () -> Void
    @State private var player: AVAudioPlayer?
    var body: some View {
        HStack(spacing: 10) {
            Button {
                guard !store.callCenter.inCall else { store.show(L("voice.callBusy")); return }
                do {
                    if player?.isPlaying == true { player?.pause(); return }
                    if player == nil { player = try AVAudioPlayer(data: data) }
                    try AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
                    try AVAudioSession.sharedInstance().setActive(true)
                    guard player?.play() == true else { throw CocoaError(.fileReadCorruptFile) }
                } catch { store.show(L("voice.unreadable")) }
            } label: { Image(systemName: "play.fill").frame(width: 44, height: 44) }
                .accessibilityLabel(L("voice.preview"))
            Waveform(values: waveform, progress: 0, tint: Theme.orange).frame(height: 28)
            Text(L10n.duration(durationMs)).font(.caption.monospacedDigit())
            Button(role: .destructive) { player?.stop(); onDiscard() } label: { Image(systemName: "trash").frame(width: 44, height: 44) }.accessibilityLabel(L("voice.discard"))
            Button { player?.stop(); onSend() } label: { Image(systemName: "arrow.up.circle.fill").font(.title).frame(width: 44, height: 44) }.accessibilityLabel(L("chat.send"))
        }.padding(.horizontal, 12).accessibilityIdentifier("voice.preview")
        .onDisappear { player?.stop(); player = nil }
        .onChange(of: store.callCenter.inCall) { _, active in if active { player?.stop() } }
    }
}

/// Barra mientras se graba: contador, onda en vivo y la pista de deslizar; bloqueada: borrar y enviar.
struct VoiceRecordingBar: View {
    let recorder: VoiceRecorder
    var onSend: (Data, Int, [Double]) -> Void
    var onDiscard: () -> Void
    var onError: (String) -> Void = { _ in }

    var body: some View {
        HStack(spacing: 10) {
            if recorder.state == .locked {
                Button(role: .destructive) { recorder.cancel(); onDiscard() } label: {
                    Image(systemName: "trash").font(.system(size: 17, weight: .semibold)).frame(width: 40, height: 40)
                }
                .accessibilityLabel(L("voice.discard"))
                .accessibilityIdentifier("voice.discard")
            } else {
                Circle().fill(.red).frame(width: 10, height: 10).padding(.leading, 6)
            }
            if recorder.paused && recorder.canResume {
                // En pausa (llamada, pantalla bloqueada o app al fondo): continuar grabando.
                Button { recorder.resume() } label: {
                    Image(systemName: "mic.fill").font(.system(size: 15, weight: .semibold)).foregroundStyle(.red).frame(width: 32, height: 40)
                }
                .accessibilityLabel(L("voice.resume"))
                .accessibilityIdentifier("voice.resume")
            }
            Text(L10n.duration(recorder.elapsedMs)).font(.body.monospacedDigit()).foregroundStyle(Theme.textPrimary)
                .accessibilityLabel("\(recorder.paused ? L("voice.paused") : L("voice.recording")) \(L10n.duration(recorder.elapsedMs))")
                .accessibilityIdentifier("voice.elapsed")
            if recorder.paused { Text(L("voice.paused")).font(.caption.weight(.semibold)).foregroundStyle(Theme.textSecondary).lineLimit(1) }
            Waveform(values: Array(recorder.samples.suffix(40)), progress: 1, tint: Theme.orange).frame(height: 26).accessibilityHidden(true)
            if recorder.state == .locked {
                Button {
                    switch recorder.finishOutcome() {
                    case .success(let r): onSend(r.data, r.durationMs, r.waveform)
                    case .failure(let e): onError(e == .tooShort ? L("voice.tooShort") : L("voice.unreadable"))
                    }
                } label: {
                    Image(systemName: "stop.fill").font(.system(size: 17, weight: .bold)).foregroundStyle(.white)
                        .frame(width: 40, height: 40).background(Circle().fill(Theme.bubbleMine))
                }
                .accessibilityLabel(L("voice.preview"))
                .accessibilityIdentifier("voice.send")
            } else {
                VStack(alignment: .trailing, spacing: 1) {
                    Text(L("voice.slideCancel")).font(.caption2)
                    Label(L("voice.slideLock"), systemImage: "lock").font(.caption2)
                }
                .foregroundStyle(Theme.textSecondary)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .frame(maxWidth: .infinity)
        .background(RoundedRectangle(cornerRadius: 20).fill(Theme.background))
        .accessibilityIdentifier("voice.recordingBar")
    }
}
