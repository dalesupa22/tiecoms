import Foundation

enum SocketError: Error, Equatable {
    case notConnected
    case ackTimeout
    case disconnected
}

/// Cliente Socket.IO mínimo y propio sobre `URLSessionWebSocketTask`.
///
/// - Solo transporte WebSocket (sin long-polling), espacio de nombres "/".
/// - Responde a los ping del servidor y reconecta si el servidor calla más de
///   `pingInterval + pingTimeout`.
/// - Reconexión con retroceso exponencial y jitter (0,5 s → 30 s).
/// - El token se pide en cada intento (`tokenProvider`), así una reconexión
///   usa siempre el access token vigente.
@MainActor
final class SocketIOClient {
    enum State: Equatable { case disconnected, connecting, connected }

    var onStateChange: ((State) -> Void)?
    /// Evento del servidor: nombre y primer argumento (ya parseado con JSONSerialization).
    var onEvent: ((String, Any?) -> Void)?
    /// El servidor rechazó el CONNECT (p. ej. "unauthorized").
    var onConnectError: ((String) -> Void)?
    var tokenProvider: (() async -> String?)?

    private(set) var state: State = .disconnected { didSet { if state != oldValue { onStateChange?(state) } } }
    private(set) var lastOpen: EnginePacket.OpenInfo?

    private let url: URL
    private let session: URLSession
    private var task: URLSessionWebSocketTask?
    private var generation = 0
    private var shouldRun = false
    private var attempts = 0
    private var reconnectTask: Task<Void, Never>?
    private var watchdog: Task<Void, Never>?
    private var nextAckId = 0
    private var acks: [Int: CheckedContinuation<Any?, Error>] = [:]

    /// Hora del último paquete recibido (para diagnóstico y pruebas).
    private(set) var lastFrameAt: Date?

    init(baseURL: URL, session: URLSession = URLSession(configuration: .default)) {
        self.url = SocketIOClient.socketURL(for: baseURL)
        self.session = session
    }

    /// `wss://host/api/socket.io/?EIO=4&transport=websocket` (ws:// si la base es http).
    nonisolated static func socketURL(for base: URL) -> URL {
        var c = URLComponents(url: base, resolvingAgainstBaseURL: false) ?? URLComponents()
        c.scheme = (base.scheme == "https") ? "wss" : "ws"
        let prefix = c.path.hasSuffix("/") ? String(c.path.dropLast()) : c.path
        c.path = prefix + "/api/socket.io/"
        c.queryItems = [URLQueryItem(name: "EIO", value: "4"), URLQueryItem(name: "transport", value: "websocket")]
        return c.url!
    }

    // MARK: Ciclo de vida

    func connect() {
        shouldRun = true
        if state == .disconnected && reconnectTask == nil { open() }
    }

    /// Cierre voluntario: no reconecta.
    func disconnect() {
        shouldRun = false
        reconnectTask?.cancel(); reconnectTask = nil
        teardown(reason: .disconnected)
    }

    /// Reconecta ya (vuelta a primer plano, red recuperada) reiniciando el retroceso.
    func reconnectNow() {
        guard shouldRun else { return }
        attempts = 0
        if state == .connected { return }
        reconnectTask?.cancel(); reconnectTask = nil
        teardown(reason: .disconnected)
        open()
    }

    /// Simula una caída de red (pruebas): cierra el transporte y deja que la reconexión actúe.
    func dropConnectionForTesting() {
        teardown(reason: .disconnected)
        scheduleReconnect()
    }

    private func open() {
        generation += 1
        let gen = generation
        state = .connecting
        var req = URLRequest(url: url)
        req.timeoutInterval = 20
        req.setValue("ios", forHTTPHeaderField: "x-tiecoms-client")
        req.setValue(Contract.version, forHTTPHeaderField: "x-tiecoms-contract")
        let t = session.webSocketTask(with: req)
        t.maximumMessageSize = 1 << 20
        task = t
        t.resume()
        armWatchdog(seconds: 20)
        receiveLoop(task: t, gen: gen)
    }

    private func receiveLoop(task t: URLSessionWebSocketTask, gen: Int) {
        Task { @MainActor [weak self] in
            while true {
                do {
                    let msg = try await t.receive()
                    guard let self, gen == self.generation else { return }
                    switch msg {
                    case .string(let s): await self.handle(frame: s)
                    case .data(let d): await self.handle(frame: String(decoding: d, as: UTF8.self))
                    @unknown default: break
                    }
                } catch {
                    guard let self, gen == self.generation else { return }
                    self.teardown(reason: .disconnected)
                    self.scheduleReconnect()
                    return
                }
            }
        }
    }

    private func handle(frame: String) async {
        lastFrameAt = Date()
        if let o = lastOpen { armWatchdog(seconds: Double(o.pingInterval + o.pingTimeout) / 1000) }
        switch EnginePacket.parse(frame) {
        case .open(let info):
            lastOpen = info
            armWatchdog(seconds: Double(info.pingInterval + info.pingTimeout) / 1000)
            let gen = generation
            let token = await tokenProvider?() ?? ""
            guard gen == generation else { return }
            send(.message(.connect(auth: ["token": token])))
        case .ping:
            send(.pong)
        case .close:
            teardown(reason: .disconnected)
            scheduleReconnect()
        case .message(let p):
            handle(packet: p)
        case .pong, .upgrade, .noop, .invalid:
            break
        }
    }

    private func handle(packet p: SocketPacket) {
        guard p.namespace == "/" else { return }
        switch p.kind {
        case .connect:
            attempts = 0
            state = .connected
        case .connectError:
            let message = (p.jsonObject?["message"] as? String) ?? "connect_error"
            teardown(reason: .disconnected)
            onConnectError?(message)
            scheduleReconnect()
        case .disconnect:
            // El servidor nos expulsó (p. ej. sesión revocada): se reintenta y el token decidirá.
            teardown(reason: .disconnected)
            scheduleReconnect()
        case .event, .binaryEvent:
            if let e = p.event { onEvent?(e.name, e.args.first) }
        case .ack, .binaryAck:
            if let id = p.ackId, let cont = acks.removeValue(forKey: id) {
                cont.resume(returning: p.jsonArray?.first)
            }
        }
    }

    private func send(_ packet: EnginePacket) {
        task?.send(.string(packet.encoded)) { _ in }
    }

    private func armWatchdog(seconds: Double) {
        watchdog?.cancel()
        let gen = generation
        watchdog = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            guard !Task.isCancelled, let self, gen == self.generation, self.task != nil else { return }
            self.teardown(reason: .disconnected)
            self.scheduleReconnect()
        }
    }

    private func teardown(reason: SocketError) {
        generation += 1
        watchdog?.cancel(); watchdog = nil
        if let t = task { t.cancel(with: .goingAway, reason: nil) }
        task = nil
        let pending = acks
        acks.removeAll()
        pending.values.forEach { $0.resume(throwing: reason) }
        state = .disconnected
    }

    /// Retroceso exponencial con jitter: base = 0,5·2^n; espera en [base, 1,5·base], tope 30 s.
    nonisolated static func backoffDelay(attempt: Int, random: Double = Double.random(in: 0...1)) -> Double {
        let base = min(30, 0.5 * pow(2, Double(min(max(0, attempt), 10))))
        return min(30, base * (1 + 0.5 * random))
    }

    private func scheduleReconnect() {
        guard shouldRun, reconnectTask == nil else { return }
        let delay = SocketIOClient.backoffDelay(attempt: attempts)
        attempts += 1
        reconnectTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard let self, !Task.isCancelled else { return }
            self.reconnectTask = nil
            if self.shouldRun && self.state == .disconnected { self.open() }
        }
    }

    // MARK: Emisión

    func emit(_ name: String, _ payload: Any?) {
        guard state == .connected else { return }
        send(.message(.event(name, payload)))
    }

    /// Emite con ACK. Lanza `ackTimeout` si no hay respuesta a tiempo.
    func emitWithAck(_ name: String, _ payload: Any?, timeout: TimeInterval = 8) async throws -> Any? {
        guard state == .connected else { throw SocketError.notConnected }
        let id = nextAckId
        nextAckId += 1
        let gen = generation
        return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Any?, Error>) in
            acks[id] = cont
            send(.message(.event(name, payload, ackId: id)))
            Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                guard let self, let c = self.acks.removeValue(forKey: id) else { return }
                _ = gen
                c.resume(throwing: SocketError.ackTimeout)
            }
        }
    }
}
