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
    /// Burbuja de otra persona: gris cálido.
    static let bubbleOther = Color(light: 0xEFEBE6, dark: 0x2E2A27)
    static let textPrimary = Color(light: 0x1F1F1F, dark: 0xF4F1EA)
    static let textSecondary = Color(light: 0x6B645B, dark: 0xA8A29A)
    /// Naranja para texto sobre fondo claro/oscuro con contraste suficiente.
    static let accentText = Color(light: 0xB35500, dark: 0xFF8A1F)
    /// Burbuja propia: naranja sobrio (#E8710A en claro, #C75F08 en oscuro), con texto blanco.
    static let bubbleMine = Color(light: 0xE8710A, dark: 0xC75F08)
}

extension Theme {
    /// Contraste WCAG de un color "#RRGGBB" con texto blanco.
    static func contrastWithWhite(_ css: String) -> Double? {
        let s = css.trimmingCharacters(in: CharacterSet(charactersIn: "# "))
        guard s.count == 6, let v = UInt32(s, radix: 16) else { return nil }
        func lin(_ c: UInt32) -> Double { let x = Double(c) / 255; return x <= 0.03928 ? x / 12.92 : pow((x + 0.055) / 1.055, 2.4) }
        let l = 0.2126 * lin((v >> 16) & 0xFF) + 0.7152 * lin((v >> 8) & 0xFF) + 0.0722 * lin(v & 0xFF)
        return 1.05 / (l + 0.05)
    }

    /// Naranja sobrio de los badges (#B45309, AA con texto blanco en letra chica) y gris del silenciado; igual que la web.
    static let badgeFallback = Color(hex: 0xB45309)
    static let badgeMuted = Color(hex: 0x7A7368)

    /// Badge de no leídos: el color de la empresa solo si cumple AA (4,5:1) con texto blanco; si no, el naranja sobrio.
    static func badgeColor(_ css: String) -> Color? {
        guard let r = contrastWithWhite(css), r >= 4.5 else { return nil }
        return Color(css: css)
    }
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
    /// Ruta relativa de la foto (/api/v1/avatars/…); sin foto o mientras carga, iniciales.
    var photo: String? = nil
    /// Marca de la empresa en la esquina (como la web con tamaño ≥ 30).
    var badge = false
    /// Color propio (PersonColor) en vez del de la empresa: iniciales en blanco.
    var fill: Color? = nil

    /// Avatar de una persona del snapshot (foto, iniciales o ◇ si es agente).
    init(person: PersonDTO?, org: OrganizationDTO?, size: CGFloat = 40, badge: Bool = false) {
        self.name = person?.name ?? "?"
        self.org = org
        self.isAgent = person?.kind == "agent"
        self.size = size
        self.photo = person?.avatarUrl
        self.badge = badge
        // Como la web: iniciales blancas sobre el color estable de la persona; la empresa va en la insignia.
        self.fill = person.map { PersonColor.fill($0.id) }
    }

    init(name: String, org: OrganizationDTO?, isAgent: Bool = false, size: CGFloat = 40, photo: String? = nil, badge: Bool = false, fill: Color? = nil) {
        self.name = name; self.org = org; self.isAgent = isAgent; self.size = size; self.photo = photo; self.badge = badge; self.fill = fill
    }

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: isAgent ? 10 : size / 2)
        ZStack {
            shape.fill(isAgent ? Theme.ink : fill ?? Color(css: org?.colorBg ?? "#E0DACE"))
            Text(isAgent ? "◇" : Naming.initials(name))
                .font(.system(size: size * 0.36, weight: .semibold))
                .foregroundStyle(isAgent ? Theme.cream : fill != nil ? Color.white : Color(css: org?.colorFg ?? "#5C554C"))
            if let url = MediaURL.absolute(photo) {
                RemoteImage(url: url) { img in img.resizable().scaledToFill() }
                    .frame(width: size, height: size)
                    .clipShape(shape)
            }
        }
        .frame(width: size, height: size)
        .overlay(alignment: .bottomTrailing) {
            if badge, let org {
                OrgMark(org: org, size: max(12, size * 0.42))
                    .overlay(RoundedRectangle(cornerRadius: size * 0.42 * 0.28).stroke(Theme.surface, lineWidth: 1.5))
                    .offset(x: size * 0.08, y: size * 0.08)
            }
        }
        .accessibilityHidden(true)
    }
}

/// Caritas apiladas de un chat grupal (hasta 3). `box` > 0 las acomoda en un cuadro de ese lado
/// (lista de chats: mismo ancho que el avatar de un directo); si no, en fila solapada como la web.
struct StackedAvatars: View {
    var d: BootstrapDTO
    var c: ConversationDTO
    var size: CGFloat = 24
    var box: CGFloat = 0

    var body: some View {
        let others = Array(Naming.others(d, c).prefix(3))
        Group {
            if box > 0 { cluster(others) } else { row(others) }
        }
        .accessibilityHidden(true)
    }

    private func face(_ p: PersonDTO, _ s: CGFloat) -> some View {
        Avatar(person: p, org: Naming.org(d, p.orgId), size: s)
            .overlay(Circle().stroke(Theme.surface, lineWidth: 1.5))
    }

    @ViewBuilder private func row(_ others: [PersonDTO]) -> some View {
        let step = size * 0.55
        ZStack(alignment: .leading) {
            ForEach(Array(others.enumerated()), id: \.element.id) { i, p in
                face(p, size).offset(x: CGFloat(i) * step).zIndex(Double(3 - i))
            }
        }
        .frame(width: size + CGFloat(max(0, others.count - 1)) * step, height: size, alignment: .leading)
    }

    @ViewBuilder private func cluster(_ others: [PersonDTO]) -> some View {
        switch others.count {
        case 0: Avatar(name: "?", org: nil, size: box)
        case 1: face(others[0], box)
        case 2:
            let s = box * 0.68
            ZStack(alignment: .topLeading) {
                face(others[0], s)
                face(others[1], s).offset(x: box - s, y: box - s)
            }
            .frame(width: box, height: box, alignment: .topLeading)
        default:
            let s = box * 0.56
            ZStack(alignment: .topLeading) {
                face(others[0], s).offset(x: (box - s) / 2, y: 0)
                face(others[1], s).offset(x: 0, y: box - s)
                face(others[2], s).offset(x: box - s, y: box - s)
            }
            .frame(width: box, height: box, alignment: .topLeading)
        }
    }
}

/// Imagen pública del API (fotos, miniaturas) con caché en memoria; URLCache guarda en disco
/// según el cache-control inmutable que envía el servidor.
struct RemoteImage<Content: View>: View {
    let url: URL
    @ViewBuilder var content: (Image) -> Content
    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image { content(Image(uiImage: image)) } else { Color.clear }
        }
        .task(id: url) {
            if let hit = RemoteImageCache.shared.object(forKey: url as NSURL) { image = hit; return }
            image = nil
            guard let (data, resp) = try? await RemoteImageCache.session.data(from: url),
                  (resp as? HTTPURLResponse).map({ (200..<300).contains($0.statusCode) }) ?? false,
                  let img = UIImage(data: data) else { return }
            RemoteImageCache.shared.setObject(img, forKey: url as NSURL)
            image = img
        }
    }
}

enum RemoteImageCache {
    static let shared: NSCache<NSURL, UIImage> = { let c = NSCache<NSURL, UIImage>(); c.countLimit = 300; return c }()
    static let session: URLSession = {
        let cfg = URLSessionConfiguration.default
        cfg.urlCache = URLCache(memoryCapacity: 8 << 20, diskCapacity: 80 << 20)
        cfg.requestCachePolicy = .returnCacheDataElseLoad
        cfg.timeoutIntervalForRequest = 20
        return URLSession(configuration: cfg)
    }()
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
