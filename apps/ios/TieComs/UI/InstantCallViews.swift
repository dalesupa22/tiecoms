import SwiftUI
import UIKit

// «Nueva llamada» (1.7.6, Core/InstantCall.swift): botón grande en Llamadas → hoja corta (título opcional, Voz/Video)
// → la llamada → hoja «Comparte el enlace». Dentro de la llamada, 🔗 la vuelve a abrir.

/// Botón principal de la pestaña Llamadas.
struct NewInstantCallButton: View {
    var action: () -> Void
    var body: some View {
        Button(action: { Haptics.tap(); action() }) {
            HStack(spacing: 14) {
                Image(systemName: "link.badge.plus")
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(Theme.onPrimary)
                    .frame(width: 48, height: 48)
                    .background(Circle().fill(Theme.onPrimary.opacity(0.18)))
                VStack(alignment: .leading, spacing: 2) {
                    Text(L("calls.instant.new")).font(.headline)
                    Text(L("calls.instant.newSub")).font(.footnote).opacity(0.85).multilineTextAlignment(.leading)
                }
                .foregroundStyle(Theme.onPrimary)
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").font(.subheadline.weight(.bold)).foregroundStyle(Theme.onPrimary.opacity(0.8))
            }
            .padding(.horizontal, 16).padding(.vertical, 14)
            .frame(maxWidth: .infinity)
            .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Theme.primaryFill))
            .contentShape(RoundedRectangle(cornerRadius: 18))
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(L("calls.instant.new"))
        .accessibilityHint(L("calls.instant.newSub"))
        .accessibilityIdentifier("calls.instant")
    }
}

/// Hoja corta: título opcional y Voz/Video. Por defecto voz y título automático: un solo toque en «Empezar».
struct InstantCallSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    /// Llamada creada: quien abrió la hoja entra a ella cuando la hoja termina de cerrarse.
    var onCreated: (InstantCallDTO, Bool, String) -> Void
    @State private var title = ""
    @State private var video = false
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        let auto = InstantCallRules.autoTitle(myName: store.me?.name)
        NavigationStack {
            Form {
                Section {
                    TextField(auto, text: $title)
                        .textInputAutocapitalization(.sentences)
                        .submitLabel(.go)
                        .onSubmit(start)
                        .accessibilityLabel(L("calls.instant.titleLabel"))
                        .accessibilityIdentifier("calls.instant.title")
                } header: { Text(L("calls.instant.titleLabel")) } footer: { Text(L("calls.instant.titleHint")) }
                Section {
                    Picker(L("calls.instant.kind"), selection: $video) {
                        Label(L("calls.instant.voice"), systemImage: "phone.fill").tag(false)
                        Label(L("calls.instant.video"), systemImage: "video.fill").tag(true)
                    }
                    .pickerStyle(.segmented)
                    .accessibilityIdentifier("calls.instant.kind")
                } footer: { Text(L("calls.instant.linkHint")) }
                if let error {
                    Section {
                        Label(error, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(Theme.accentText)
                            .accessibilityElement(children: .ignore)
                            .accessibilityLabel(error)
                            .accessibilityIdentifier("calls.instant.error")
                    }
                }
                Section {
                    Button(action: start) {
                        HStack {
                            Spacer()
                            if busy { ProgressView().tint(Theme.onPrimary) }
                            Label(L("calls.instant.start"), systemImage: video ? "video.fill" : "phone.fill").font(.headline)
                            Spacer()
                        }
                        .foregroundStyle(Theme.onPrimary)
                        .padding(.vertical, 6)
                    }
                    .listRowBackground(Theme.primaryFill.opacity(busy ? 0.6 : 1))
                    .disabled(busy)
                    .accessibilityIdentifier("calls.instant.start")
                }
            }
            .navigationTitle(L("calls.instant.new"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L("common.cancel")) { dismiss() }.accessibilityIdentifier("calls.instant.cancel")
                }
            }
        }
    }

    private func start() {
        guard !busy else { return }
        busy = true; error = nil
        let t = InstantCallRules.title(title, myName: store.me?.name), v = video
        Task {
            defer { busy = false }
            do {
                let r = try await store.startInstantCallRequest(title: t, video: v)
                onCreated(r, v, t)
                dismiss()
            } catch { self.error = InstantCallRules.errorText(error) }
        }
    }
}

/// «Comparte el enlace»: el enlace, Copiar y la hoja del sistema (WhatsApp, Mensajes, Correo…).
struct CallLinkShareSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let link: CallShareLink
    @State private var copied = false

    var body: some View {
        let text = InstantCallRules.shareText(link.url)
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    HStack(spacing: 12) {
                        Image(systemName: "link").font(.title2.weight(.semibold)).foregroundStyle(Theme.onPrimary)
                            .frame(width: 48, height: 48).background(Circle().fill(Theme.primaryFill))
                        VStack(alignment: .leading, spacing: 2) {
                            Text(L("calls.instant.shareTitle")).font(.title3.weight(.bold)).foregroundStyle(Theme.textPrimary)
                            Text(L("calls.instant.shareSub")).font(.subheadline).foregroundStyle(Theme.textSecondary)
                        }
                    }
                    Text(link.url)
                        .font(.body.monospaced()).foregroundStyle(Theme.textPrimary)
                        .textSelection(.enabled)
                        .lineLimit(3)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(14)
                        .background(RoundedRectangle(cornerRadius: 12).fill(Theme.surface))
                        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.textSecondary.opacity(0.25)))
                        .accessibilityIdentifier("call.link.url")
                    HStack(spacing: 10) {
                        Button {
                            UIPasteboard.general.string = link.url
                            copied = true
                            Haptics.tap()
                            store.show(L("toast.linkCopied"))
                        } label: {
                            Label(copied ? L("calls.instant.copied") : L("calls.instant.copy"), systemImage: copied ? "checkmark" : "doc.on.doc")
                                .font(.headline).frame(maxWidth: .infinity).frame(height: 48)
                                .foregroundStyle(Theme.accentText)
                                .background(RoundedRectangle(cornerRadius: 12).stroke(Theme.accentText, lineWidth: 1.5))
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("call.link.copy")
                        ShareLink(item: text, subject: Text(L("calls.instant.shareSubject")), message: Text(text)) {
                            Label(L("calls.instant.share"), systemImage: "square.and.arrow.up")
                                .font(.headline).frame(maxWidth: .infinity).frame(height: 48)
                                .foregroundStyle(Theme.onPrimary)
                                .background(RoundedRectangle(cornerRadius: 12).fill(Theme.primaryFill))
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("call.link.share")
                    }
                    VStack(alignment: .leading, spacing: 6) {
                        Text(L("calls.instant.suggested")).font(.footnote.weight(.semibold)).foregroundStyle(Theme.textSecondary)
                        Text(text).font(.subheadline).foregroundStyle(Theme.textPrimary)
                            .textSelection(.enabled)
                            .accessibilityIdentifier("call.link.text")
                    }
                    Label(L("calls.instant.expires"), systemImage: "clock.badge.xmark")
                        .font(.footnote).foregroundStyle(Theme.textSecondary)
                }
                .padding(16)
            }
            .background(Theme.background.ignoresSafeArea())
            .navigationTitle(L("calls.instant.shareNav"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(L("common.done")) { dismiss() }.accessibilityIdentifier("call.link.done")
                }
            }
        }
        .accessibilityIdentifier("call.link.sheet")
    }
}

/// Quienes están en la llamada: personas de chaggu y los invitados por enlace con su nombre y correo.
struct CallParticipantsSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            if let v = store.callCenter.view {
                let ctx = CallPeopleContext(d: store.data, me: v.isGuest ? (store.callCenter.guest?.userId ?? "") : (store.data?.me.id ?? ""), call: v.call)
                List {
                    Section {
                        ForEach(ctx.inside, id: \.self) { id in
                            HStack(spacing: 12) {
                                ctx.avatar(id, size: 36)
                                VStack(alignment: .leading, spacing: 2) {
                                    HStack(spacing: 6) {
                                        Text(id == ctx.me ? L("call.you") : ctx.fullName(id)).foregroundStyle(Theme.textPrimary).lineLimit(1)
                                        if ctx.isGuest(id) {
                                            Text(L("call.guestBadge")).font(.caption2.weight(.semibold)).foregroundStyle(.white)
                                                .padding(.horizontal, 6).padding(.vertical, 1)
                                                .background(Capsule().fill(Theme.badgeFallback))
                                        }
                                    }
                                    if let e = CallRules.guestEmail(v.call, id) {
                                        Text(e).font(.footnote).foregroundStyle(Theme.textSecondary).lineLimit(1).textSelection(.enabled)
                                            .accessibilityIdentifier("call.people.email.\(id)")
                                    }
                                }
                                Spacer()
                                if (id == ctx.me ? v.muted : v.mutedUsers.contains(id)) {
                                    Image(systemName: "mic.slash.fill").foregroundStyle(.red).accessibilityLabel(L("call.mutedPerson"))
                                }
                            }
                            .accessibilityElement(children: .combine)
                            .accessibilityIdentifier("call.people.\(id)")
                        }
                    } footer: {
                        if store.callCenter.currentShareLink != nil { Text(L("calls.instant.peopleHint")) }
                    }
                }
                .navigationTitle(L("calls.instant.people", ["n": ctx.inside.count]))
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) { Button(L("common.done")) { dismiss() }.accessibilityIdentifier("call.people.done") }
                }
            }
        }
    }
}
