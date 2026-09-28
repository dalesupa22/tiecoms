import SwiftUI

/// «Tamaño del texto» de la app (Tú › Ajustes): cinco pasos que se SUMAN al Dynamic Type del sistema, no lo ignoran.
/// Normal es el tamaño de hoy (el del sistema); cada paso mueve la categoría de Dynamic Type. Se guarda en
/// UserDefaults y en el App Group (lo lee la extensión Compartir).
enum TextSize: Int, CaseIterable, Identifiable, Sendable {
    case small, normal, large, larger, largest
    var id: Int { rawValue }

    static let key = "tc.textSize"
    static let appGroup = "group.com.chaggu.app"

    /// Pasos de Dynamic Type respecto al del sistema. «Máximo» llega a la primera categoría de accesibilidad
    /// cuando el sistema está en su tamaño por defecto.
    var steps: Int {
        switch self {
        case .small: return -1
        case .normal: return 0
        case .large: return 1
        case .larger: return 2
        case .largest: return 4
        }
    }

    var labelKey: String {
        switch self {
        case .small: return "textSize.small"
        case .normal: return "textSize.normal"
        case .large: return "textSize.large"
        case .larger: return "textSize.larger"
        case .largest: return "textSize.largest"
        }
    }

    /// La categoría resultante: la del sistema desplazada `steps`, dentro de los límites de DynamicTypeSize.
    func applied(to system: DynamicTypeSize) -> DynamicTypeSize {
        let all = DynamicTypeSize.allCases
        let i = all.firstIndex(of: system) ?? all.firstIndex(of: .large)!
        return all[min(max(i + steps, 0), all.count - 1)]
    }

    static var current: TextSize {
        get { TextSize(rawValue: UserDefaults.standard.object(forKey: key) as? Int ?? TextSize.normal.rawValue) ?? .normal }
        set { save(newValue) }
    }

    /// En la app y en el App Group (para las extensiones).
    static func save(_ s: TextSize, defaults: UserDefaults = .standard, shared: UserDefaults? = UserDefaults(suiteName: appGroup)) {
        defaults.set(s.rawValue, forKey: key)
        shared?.set(s.rawValue, forKey: key)
    }

    /// La extensión solo ve el App Group.
    static func shared(_ suite: UserDefaults? = UserDefaults(suiteName: appGroup)) -> TextSize {
        TextSize(rawValue: suite?.object(forKey: key) as? Int ?? TextSize.normal.rawValue) ?? .normal
    }
}

private struct SystemTypeSizeKey: EnvironmentKey { static let defaultValue: DynamicTypeSize? = nil }

extension EnvironmentValues {
    /// Dynamic Type del sistema, antes de aplicar el tamaño elegido en la app (la barra de pestañas se limita y cada
    /// pestaña vuelve a aplicar el tamaño sobre este valor).
    var systemTypeSize: DynamicTypeSize? {
        get { self[SystemTypeSizeKey.self] }
        set { self[SystemTypeSizeKey.self] = newValue }
    }
}

/// Aplica el tamaño elegido sobre el Dynamic Type del sistema.
private struct AppTextSizeModifier: ViewModifier {
    @Environment(\.dynamicTypeSize) private var inherited
    @Environment(\.systemTypeSize) private var system
    @AppStorage(TextSize.key) private var raw = TextSize.normal.rawValue
    /// En la extensión: el valor del App Group.
    var fixed: TextSize?

    func body(content: Content) -> some View {
        let base = system ?? inherited
        let size = fixed ?? TextSize(rawValue: raw) ?? .normal
        content
            .environment(\.systemTypeSize, base)
            .dynamicTypeSize(size.applied(to: base))
    }
}

extension View {
    /// Tamaño del texto de la app (en la raíz y en cada pestaña).
    func appTextSize(_ fixed: TextSize? = nil) -> some View { modifier(AppTextSizeModifier(fixed: fixed)) }

    /// Tamaño fijo que escala con Dynamic Type (y con el tamaño del texto de la app), en lugar de `.system(size:)`.
    func scaledFont(_ size: CGFloat, weight: Font.Weight = .regular, design: Font.Design = .default, relativeTo style: Font.TextStyle = .body) -> some View {
        modifier(ScaledSystemFont(size: size, weight: weight, design: design, style: style))
    }
}

private struct ScaledSystemFont: ViewModifier {
    @ScaledMetric private var size: CGFloat
    let weight: Font.Weight
    let design: Font.Design

    init(size: CGFloat, weight: Font.Weight, design: Font.Design, style: Font.TextStyle) {
        _size = ScaledMetric(wrappedValue: size, relativeTo: style)
        self.weight = weight
        self.design = design
    }

    func body(content: Content) -> some View { content.font(.system(size: size, weight: weight, design: design)) }
}
