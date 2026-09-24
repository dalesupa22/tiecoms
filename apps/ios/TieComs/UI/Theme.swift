import SwiftUI
import UIKit

enum Theme {
    static let orange = Color(hex: 0xFF7A00)
    static let orangeLight = Color(hex: 0xFF8A1F)
    static let ink = Color(hex: 0x1F1F1F)
    static let cream = Color(hex: 0xFDFAF7)

    /// Fondo general: crema en claro, casi negro en oscuro.
    static let background = Color(light: 0xFDFAF7, dark: 0x141414)
    static let surface = Color(light: 0xFFFFFF, dark: 0x1F1F1F)
    /// Burbuja de otra persona.
    static let bubbleOther = Color(light: 0xEFEBE6, dark: 0x2C2C2E)
    static let textPrimary = Color(light: 0x1F1F1F, dark: 0xF4F1EA)
    static let textSecondary = Color(light: 0x6B645B, dark: 0xA8A29A)
    /// Naranja para texto sobre fondo claro/oscuro con contraste suficiente.
    static let accentText = Color(light: 0xB35500, dark: 0xFF8A1F)
    /// Burbuja propia: naranja de marca, un tono apenas más oscuro que #FF7A00 para
    /// ganar contraste con el texto blanco.
    static let bubbleMine = Color(hex: 0xE96F00)
}

extension Color {
    init(hex: UInt32, alpha: Double = 1) {
        self.init(.sRGB, red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255, opacity: alpha)
    }

    init(light: UInt32, dark: UInt32) {
        self.init(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(hex: dark) : UIColor(hex: light) })
    }

    /// "#RRGGBB" de la API (colores de empresa).
    init(css: String, fallback: Color = .gray) {
        let s = css.trimmingCharacters(in: CharacterSet(charactersIn: "# "))
        if s.count == 6, let v = UInt32(s, radix: 16) { self.init(hex: v) } else { self = fallback }
    }
}

extension UIColor {
    convenience init(hex: UInt32) {
        self.init(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }
}

/// Botón principal naranja.
struct PrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity, minHeight: 50)
            .background(RoundedRectangle(cornerRadius: 14).fill(Theme.bubbleMine.opacity(enabled ? (configuration.isPressed ? 0.8 : 1) : 0.45)))
            .contentShape(Rectangle())
    }
}

/// Marca de una empresa (iniciales sobre su color).
struct OrgMark: View {
    var org: OrganizationDTO?
    var size: CGFloat = 26
    var body: some View {
        Text(org?.mark ?? "◦")
            .font(.system(size: size * 0.4, weight: .bold))
            .foregroundStyle(Color(css: org?.colorFg ?? "#5C554C"))
            .frame(width: size, height: size)
            .background(RoundedRectangle(cornerRadius: size * 0.28).fill(Color(css: org?.colorBg ?? "#E0DACE")))
            .accessibilityHidden(true)
    }
}

struct Avatar: View {
    var name: String
    var org: OrganizationDTO?
    var isAgent = false
    var size: CGFloat = 40
    var body: some View {
        Text(isAgent ? "◇" : Naming.initials(name))
            .font(.system(size: size * 0.36, weight: .semibold))
            .foregroundStyle(isAgent ? Theme.cream : Color(css: org?.colorFg ?? "#5C554C"))
            .frame(width: size, height: size)
            .background(
                RoundedRectangle(cornerRadius: isAgent ? 10 : size / 2)
                    .fill(isAgent ? Theme.ink : Color(css: org?.colorBg ?? "#E0DACE"))
            )
            .accessibilityHidden(true)
    }
}

/// Logo sobre su fondo crema (legible también en modo oscuro).
struct LogoView: View {
    var width: CGFloat = 220
    var body: some View {
        Image("Logo")
            .resizable()
            .scaledToFit()
            .frame(width: width)
            .padding(8)
            .background(RoundedRectangle(cornerRadius: 20).fill(Theme.cream))
            .accessibilityLabel("TieComs")
    }
}
