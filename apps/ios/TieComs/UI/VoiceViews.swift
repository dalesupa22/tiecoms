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
                Button { Task { await player.toggle(att, api: store.api) } } label: {
                    Image(systemName: isCurrent && player.playing ? "pause.fill" : "play.fill")
                        .font(.system(size: 16, weight: .bold))
                        .foregroundStyle(mine ? Theme.bubbleMine : .white)
                        .frame(width: 36, height: 36)
                        .background(Circle().fill(mine ? Color.white : Theme.bubbleMine))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(isCurrent && player.playing ? L("voice.pause") : L("voice.play"))
                .accessibilityIdentifier("voice.play.\(att.id)")
                Waveform(values: att.waveform ?? [], progress: isCurrent ? player.progress : 0, tint: tint) { f in player.seek(att, to: f) }
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

/// Botón de micrófono del compositor (cuando está vacío): mantener pulsado graba, soltar envía,
/// deslizar a la izquierda cancela y deslizar arriba bloquea (manos libres con enviar/borrar).
struct VoiceRecordButton: View {
    @Environment(AppStore.self) private var store
    let recorder: VoiceRecorder
    var onSend: (Data, Int, [Double]) -> Void
    @State private var drag: CGSize = .zero
    @State private var pressing = false
    @State private var denied = false

    static let cancelDistance: CGFloat = 110
    static let lockDistance: CGFloat = 80

    var body: some View {
        Image(systemName: "mic.fill")
            .font(.system(size: 18, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: 40, height: 40)
            .background(Circle().fill(pressing ? Theme.orange : Theme.bubbleMine))
            .scaleEffect(pressing ? 1.35 : 1)
            .offset(x: pressing ? min(0, drag.width) : 0, y: pressing ? min(0, drag.height) : 0)
            .animation(.spring(response: 0.25), value: pressing)
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { v in
                        if !pressing { begin() }
                        drag = v.translation
                        guard recorder.state == .recording else { return }
                        if v.translation.width < -Self.cancelDistance { cancel() }
                        else if v.translation.height < -Self.lockDistance { recorder.lock(); pressing = false; Haptics.tap() }
                    }
                    .onEnded { _ in
                        if recorder.state == .recording { send() }
                        pressing = false; drag = .zero
                    }
            )
            .accessibilityLabel(L("voice.hold"))
            .accessibilityHint(L("voice.slideLock"))
            .accessibilityAddTraits(.isButton)
            // VoiceOver: un toque inicia la grabación bloqueada (enviar/borrar en la barra).
            .accessibilityAction { begin(locked: true) }
            .accessibilityIdentifier("composer.mic")
            .alert(L("voice.micDenied"), isPresented: $denied) {
                Button(L("common.close"), role: .cancel) {}
                Button(L("settings.nav")) { if let u = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(u) } }
            }
    }

    private func begin(locked: Bool = false) {
        pressing = !locked
        Task {
            guard await VoiceRecorder.requestPermission() else { pressing = false; denied = true; return }
            // Si soltó mientras se pedía permiso, no se graba.
            guard pressing || locked else { return }
            do {
                try recorder.start()
                if locked { recorder.lock() }
                UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            } catch { pressing = false; store.show(L("voice.micUnavailable")) }
        }
    }

    private func cancel() {
        recorder.cancel()
        pressing = false
        UINotificationFeedbackGenerator().notificationOccurred(.warning)
        store.show(L("voice.cancelled"))
    }

    private func send() {
        guard let r = recorder.finish() else { store.show(L("voice.tooShort")); return }
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        onSend(r.data, r.durationMs, r.waveform)
    }
}

/// Barra mientras se graba: contador, onda en vivo y la pista de deslizar; bloqueada: borrar y enviar.
struct VoiceRecordingBar: View {
    let recorder: VoiceRecorder
    var onSend: (Data, Int, [Double]) -> Void
    var onDiscard: () -> Void

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
            Text(L10n.duration(recorder.elapsedMs)).font(.body.monospacedDigit()).foregroundStyle(Theme.textPrimary)
                .accessibilityLabel("\(L("voice.recording")) \(L10n.duration(recorder.elapsedMs))")
            Waveform(values: Array(recorder.samples.suffix(40)), progress: 1, tint: Theme.orange).frame(height: 26).accessibilityHidden(true)
            if recorder.state == .locked {
                Button {
                    if let r = recorder.finish() { onSend(r.data, r.durationMs, r.waveform) } else { onDiscard() }
                } label: {
                    Image(systemName: "arrow.up").font(.system(size: 17, weight: .bold)).foregroundStyle(.white)
                        .frame(width: 40, height: 40).background(Circle().fill(Theme.bubbleMine))
                }
                .accessibilityLabel(L("voice.send"))
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
