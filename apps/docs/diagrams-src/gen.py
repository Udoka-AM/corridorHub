"""
Corridor architecture diagrams, cloud-architecture style, in the website's brand:
black/white, Space Mono (embedded), small radii, single ink, FIG markers.
Emits <name>-light.svg and <name>-dark.svg per diagram into ../images/diagrams.
Run: python3 diagrams-src/gen.py   (icons: Lucide, ISC; font: Space Mono, OFL; marks: @web3icons)
"""
import base64, os, re, html

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "images", "diagrams")
os.makedirs(OUT, exist_ok=True)

FONT400 = base64.b64encode(open(f"{HERE}/fonts/sm400.woff2", "rb").read()).decode()
FONT700 = base64.b64encode(open(f"{HERE}/fonts/sm700.woff2", "rb").read()).decode()

THEMES = {
    "dark": dict(bg="#050505", ink="#F4F4F0", muted="#8D8D8D", faint="#5A5A5A", line="#2A2A2A",
                 zone="#0C0C0C", card="#111111", tile="#1A1A1A", pill="#050505"),
    "light": dict(bg="#F4F4F0", ink="#050505", muted="#5D5D5A", faint="#9A9A96", line="#D6D6D0",
                  zone="#EDEDE8", card="#FFFFFF", tile="#F4F4F0", pill="#F4F4F0"),
}


def esc(s):
    return html.escape(str(s), quote=True)


def icon_inner(name):
    """Lucide icon children, or a chain mark (prefixed 'mark:')."""
    if name.startswith("mark:"):
        svg = open(f"{HERE}/marks/{name[5:]}.svg").read()
    else:
        svg = open(f"{HERE}/icons/{name}.svg").read()
    inner = re.sub(r"^.*?<svg[^>]*>", "", svg, flags=re.S)
    inner = re.sub(r"</svg>\s*$", "", inner, flags=re.S)
    return inner


_uid = [0]


def uid():
    _uid[0] += 1
    return f"u{_uid[0]}"


class D:
    def __init__(self, name, w, h, fig, title):
        self.name, self.w, self.h, self.fig, self.title = name, w, h, fig, title
        self.items = []  # callables(theme) -> str

    def add(self, fn):
        self.items.append(fn)

    # ---------- primitives ----------
    def text(self, x, y, s, size=12, weight=400, color="ink", anchor="start", spacing=0, upper=False):
        s = s.upper() if upper else s
        self.add(lambda t: f'<text x="{x}" y="{y}" font-size="{size}" font-weight="{weight}" fill="{t[color]}" '
                 f'text-anchor="{anchor}" letter-spacing="{spacing}">{esc(s)}</text>')

    def icon(self, x, y, name, size=20, color="ink", stroke=1.75):
        inner = icon_inner(name)
        mark = name.startswith("mark:")
        s = size / 24

        def f(t):
            c = t[color]
            if mark:
                return f'<g transform="translate({x},{y}) scale({s})" color="{c}" style="color:{c}">{inner}</g>'
            return (f'<g transform="translate({x},{y}) scale({s})" fill="none" stroke="{c}" stroke-width="{stroke}" '
                    f'stroke-linecap="round" stroke-linejoin="round">{inner}</g>')
        self.add(f)

    def zone(self, x, y, w, h, label, icon=None, dashed=True):
        dz = 'stroke-dasharray="5 5"' if dashed else ""
        self.add(lambda t: f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="14" fill="{t["zone"]}" stroke="{t["line"]}" '
                 f'stroke-width="1" {dz}/>')
        lx = x + 16
        if icon:
            self.icon(lx, y + 13, icon, 14, "muted")
            lx += 22
        self.text(lx, y + 25, label, 10.5, 400, "muted", spacing=1.6, upper=True)

    def node(self, x, y, w, title, sub=None, icon=None, inverted=False, h=None, dashed=False):
        h = h or (64 if sub else 52)

        def box(t):
            fill = t["ink"] if inverted else t["card"]
            stroke = t["ink"] if inverted else t["line"]
            d = 'stroke-dasharray="4 4"' if dashed else ""
            return (f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="10" fill="{fill}" stroke="{stroke}" {d}/>')
        self.add(box)
        tx = x + 14
        if icon:
            ts = 36
            ty = y + (h - ts) / 2

            def tile(t):
                fill = t["bg"] if inverted else t["tile"]
                return f'<rect x="{x+12}" y="{ty}" width="{ts}" height="{ts}" rx="8" fill="{fill}"/>'
            self.add(tile)
            self.icon(x + 12 + 8, ty + 8, icon, 20, "ink")
            tx = x + 12 + ts + 12
        ink = "bg" if inverted else "ink"
        sub_c = "faint" if inverted else "muted"
        if sub:
            self.text(tx, y + h / 2 - 3, title, 13, 700, ink, spacing=-0.2)
            self.text(tx, y + h / 2 + 14, sub, 10.5, 400, sub_c)
        else:
            self.text(tx, y + h / 2 + 4.5, title, 13, 700, ink, spacing=-0.2)
        return dict(x=x, y=y, w=w, h=h, cx=x + w / 2, cy=y + h / 2, l=x, r=x + w, t=y, b=y + h)

    def arrow(self, pts, label=None, dashed=False, lx=None, ly=None, head=True, both=False, color="ink", opacity=0.75):
        d = "M" + " L".join(f"{px},{py}" for px, py in pts)
        mid = uid()

        def f(t):
            c = t[color]
            dash = 'stroke-dasharray="5 5"' if dashed else ""
            s = (f'<defs><marker id="{mid}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">'
                 f'<path d="M0,0 L10,5 L0,10 z" fill="{c}"/></marker></defs>')
            me = f'marker-end="url(#{mid})"' if head else ""
            ms = f'marker-start="url(#{mid})"' if both else ""
            s += f'<path d="{d}" fill="none" stroke="{c}" stroke-opacity="{opacity}" stroke-width="1.5" {dash} {me} {ms}/>'
            return s
        self.add(f)
        if label:
            if lx is None:
                (x1, y1), (x2, y2) = pts[len(pts) // 2 - 1], pts[len(pts) // 2]
                lx, ly = (x1 + x2) / 2, (y1 + y2) / 2
            self.pill(lx, ly, label)

    def curve(self, p0, p1, label=None, dashed=False, bend=0.5):
        (x0, y0), (x1, y1) = p0, p1
        c1 = (x0 + (x1 - x0) * bend, y0)
        c2 = (x1 - (x1 - x0) * bend, y1)
        d = f"M{x0},{y0} C{c1[0]},{c1[1]} {c2[0]},{c2[1]} {x1},{y1}"
        mid = uid()

        def f(t):
            dash = 'stroke-dasharray="5 5"' if dashed else ""
            return (f'<defs><marker id="{mid}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">'
                    f'<path d="M0,0 L10,5 L0,10 z" fill="{t["ink"]}"/></marker></defs>'
                    f'<path d="{d}" fill="none" stroke="{t["ink"]}" stroke-opacity="0.6" stroke-width="1.5" {dash} marker-end="url(#{mid})"/>')
        self.add(f)
        if label:
            self.pill((x0 + x1) / 2, (y0 + y1) / 2, label)

    def pill(self, cx, cy, s, size=10):
        w = len(s) * size * 0.6 + 16
        self.add(lambda t: f'<rect x="{cx-w/2}" y="{cy-10}" width="{w}" height="20" rx="10" fill="{t["pill"]}" stroke="{t["line"]}"/>'
                 f'<text x="{cx}" y="{cy+3.6}" font-size="{size}" fill="{t["muted"]}" text-anchor="middle">{esc(s)}</text>')

    def vlabel(self, x, y, s, size=10):
        w = len(s) * size * 0.6 + 16
        self.add(lambda t: f'<g transform="translate({x},{y}) rotate(-90)"><rect x="{-w/2}" y="-10" width="{w}" height="20" rx="10" fill="{t["pill"]}" stroke="{t["line"]}"/>'
                 f'<text x="0" y="3.6" font-size="{size}" fill="{t["muted"]}" text-anchor="middle">{esc(s)}</text></g>')

    def badge(self, cx, cy, n):
        self.add(lambda t: f'<circle cx="{cx}" cy="{cy}" r="11" fill="{t["ink"]}"/>'
                 f'<text x="{cx}" y="{cy+4}" font-size="11" font-weight="700" fill="{t["bg"]}" text-anchor="middle">{n}</text>')

    def rect(self, x, y, w, h, fill="card", stroke="line", rx=8, dashed=False, inverted=False):
        def f(t):
            fl = t["ink"] if inverted else t[fill]
            d = 'stroke-dasharray="4 4"' if dashed else ""
            return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fl}" stroke="{t[stroke]}" {d}/>'
        self.add(f)

    def vline(self, x, y0, y1, dashed=True):
        dv = 'stroke-dasharray="4 6"' if dashed else ""
        self.add(lambda t: f'<line x1="{x}" y1="{y0}" x2="{x}" y2="{y1}" stroke="{t["line"]}" stroke-width="1.5" {dv}/>')

    # ---------- output ----------
    def render(self, theme):
        t = THEMES[theme]
        head = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {self.w} {self.h}" width="{self.w}" height="{self.h}" '
                f'role="img" aria-label="{esc(self.title)}">'
                f'<title>{esc(self.title)}</title>'
                f'<style>@font-face{{font-family:"SM";font-weight:400;src:url(data:font/woff2;base64,{FONT400}) format("woff2")}}'
                f'@font-face{{font-family:"SM";font-weight:700;src:url(data:font/woff2;base64,{FONT700}) format("woff2")}}'
                f'text{{font-family:"SM","Space Mono",ui-monospace,Menlo,monospace}}</style>'
                f'<rect width="{self.w}" height="{self.h}" fill="{t["bg"]}"/>')
        fig = (f'<text x="32" y="38" font-size="10.5" fill="{t["muted"]}" letter-spacing="1.8">{esc(self.fig.upper())}</text>'
               f'<text x="{self.w-32}" y="38" font-size="10.5" fill="{t["faint"]}" letter-spacing="1.8" text-anchor="end">CORRIDOR</text>')
        body = "".join(fn(t) for fn in self.items)
        return head + fig + body + "</svg>"

    def save(self):
        for theme in THEMES:
            _uid[0] = 0
            with open(f"{OUT}/{self.name}-{theme}.svg", "w") as f:
                f.write(self.render(theme))
        print("wrote", self.name)


# =====================================================================
# FIG 01 · System architecture
# =====================================================================
def system():
    d = D("system-architecture", 1200, 860, "Fig. 01 · System architecture", "Corridor system architecture: clients, control plane, execution legs, observers and books")
    X, W = 64, 1072
    rows = [
        (64, "Clients", "users", [("PSP / B2B API", "quotes · payouts · batches", "plug"), ("Read-only watch", "accounts · exceptions · CSV", "eye"), ("Auditor", "reconciliation trail", "file-text")]),
        (208, "Control plane", "workflow", [("Route planner", "graph · hub enforced", "route"), ("Saga engine", "leases · retries · undo", "workflow"), ("Signer interface", "customer KMS · MPC", "key-round")]),
        (352, "Execution legs", "zap", [("Stellar legs", "payment + MEMO_HASH", "mark:stellar"), ("Path payment", "on-ledger FX", "arrow-left-right"), ("Anchor legs", "SEP-10/12/31/38", "plug"), ("Cross-chain in", "CCTP · not built", "mark:solana")]),
        (496, "Observers", "radio-tower", [("Horizon payments", "memo · stored cursor", "radio-tower"), ("Anchor status", "SEP-31 polling", "scan-search"), ("Partner webhooks", "HMAC · exactly once", "webhook")]),
        (640, "Books", "book-open", [("Double-entry ledger", "Postgres · 7 dp · append-only", "database"), ("Reconciliation", "matcher · vault check", "scale")]),
    ]
    for y, label, ic, nodes in rows:
        d.zone(X, y, W, 116, label, ic)
        n = len(nodes)
        nw = 236 if n == 4 else 300
        gap = (W - 2 * 28 - n * nw) / (n - 1) if n > 1 else 0
        for i, (ti, sub, icn) in enumerate(nodes):
            d.node(X + 28 + i * (nw + gap), y + 40, nw, ti, sub, icn, dashed=(ti == "Cross-chain in"))
    labels = ["requests", "planned legs", "on-chain effects", "observations"]
    for i in range(4):
        y0 = rows[i][0] + 116
        y1 = rows[i + 1][0]
        d.arrow([(600, y0), (600, y1)], labels[i], lx=600, ly=(y0 + y1) / 2)
    # bookings down the right margin, read model back up the left margin
    d.arrow([(X + W, 410), (1164, 410), (1164, 698), (X + W, 698)])
    d.vlabel(1164, 556, "bookings")
    d.arrow([(X, 698), (36, 698), (36, 122), (X, 122)])
    d.vlabel(36, 410, "read model")
    d.text(600, 820, "One planner, one saga engine, one ledger, one matcher, every corridor and both directions. All of it runs in the customer's own environment.", 11, 400, "muted", anchor="middle")
    d.save()


# =====================================================================
# FIG 02 · Hub and spoke
# =====================================================================
def hub():
    d = D("hub-and-spoke", 1200, 640, "Fig. 02 · Hub and spoke", "Collections flow into the Stellar hub; payouts flow out to four regions, with naira reached through a partner off Stellar")
    d.zone(32, 64, 300, 520, "Collections · in", "arrow-down-to-line")
    d.zone(868, 64, 300, 520, "Payouts · out", "arrow-up-from-line")
    left = [("Africa", "KES XOF TZS GHS ZAR EGP UGX", "landmark"), ("Americas", "USD CAD", "landmark"), ("Europe", "EUR GBP", "landmark")]
    right = [("Africa", "KES XOF TZS GHS ZAR +6", "landmark"), ("Asia & Middle East", "CNY HKD INR AED SGD +5", "landmark"),
             ("Americas", "USD BRL MXN COP +4", "landmark"), ("Europe", "EUR GBP CHF", "landmark"), ("NGN", "partner off Stellar", "banknote")]
    L = []
    for i, (ti, sub, ic) in enumerate(left):
        L.append(d.node(52, 120 + i * 150, 260, ti, sub, ic))
    R = []
    for i, (ti, sub, ic) in enumerate(right):
        R.append(d.node(888, 104 + i * 94, 260, ti, sub, ic, dashed=(ti == "NGN")))
    # hub
    d.rect(470, 214, 260, 212, rx=16, inverted=True)
    d.add(lambda t: f'<rect x="570" y="244" width="60" height="60" rx="12" fill="{t["bg"]}"/>')
    d.icon(584, 258, "mark:stellar", 32, "ink")
    d.text(600, 340, "STELLAR HUB", 18, 700, "bg", anchor="middle", spacing=1)
    d.text(600, 364, "USDC balances", 11, 400, "faint", anchor="middle")
    d.text(600, 382, "ledger · saga · recon", 11, 400, "faint", anchor="middle")
    d.text(600, 404, "anchors settle here", 11, 400, "faint", anchor="middle")
    for n in L:
        d.curve((n["r"], n["cy"]), (470, 320), None)
    for n in R:
        d.curve((730, 320), (n["l"], n["cy"]), None, dashed=(n["cy"] > 480))
    d.pill(600, 470, "every flow = collection + payout")
    d.text(600, 612, "Six regions bilaterally need fifteen links; through one hub, six. Anchors speak the same SEPs, so each is a domain and an asset, not an integration.", 11, 400, "muted", anchor="middle")
    d.save()


# =====================================================================
# FIG 03 · Network topology
# =====================================================================
def topology():
    d = D("chain-topology", 1200, 560, "Fig. 03 · Network topology", "The Stellar hub with anchors settling on it directly, and USDC inflows from Base and Solana over CCTP")
    cols = [40, 280, 520, 760, 980]
    d.zone(24, 64, 232, 440, "Other chains", "link")
    d.zone(264, 64, 232, 440, "Inflow", "arrow-left-right")
    d.zone(504, 64, 232, 440, "Hub", "zap")
    d.zone(744, 64, 220, 440, "Spokes", "plug")
    d.zone(972, 64, 204, 440, "Destinations", "flag")
    W = 200
    base = d.node(cols[0], 180, W, "Base", "USDC", "mark:base")
    sol = d.node(cols[0], 340, W, "Solana", "USDC · SPL memo", "mark:solana")
    cctp = d.node(cols[1], 250, W, "CCTP", "burn and mint", "arrow-left-right", dashed=True)
    stellar = d.node(cols[2], 250, W, "Stellar", "USDC · MEMO_HASH", "mark:stellar", inverted=True)
    anchor = d.node(cols[3], 180, 190, "SEP anchor", "SEP-31 · on the hub", "plug")
    offchain = d.node(cols[3], 340, 190, "NGN partner", "settles on Solana", "banknote", dashed=True)
    rails = d.node(cols[4], 180, 184, "Local rails", "bank · mobile money", "landmark")
    bank = d.node(cols[4], 340, 184, "Nigerian bank", "NGN payout", "landmark", dashed=True)
    d.arrow([(base["r"], base["cy"]), (cctp["l"], cctp["cy"] - 12)], dashed=True)
    d.arrow([(sol["r"], sol["cy"]), (cctp["l"], cctp["cy"] + 12)], dashed=True)
    d.arrow([(cctp["r"], cctp["cy"]), (stellar["l"], stellar["cy"])], dashed=True)
    d.arrow([(stellar["r"], stellar["cy"] - 12), (742, stellar["cy"] - 12), (742, anchor["cy"]), (anchor["l"], anchor["cy"])])
    d.arrow([(anchor["r"], anchor["cy"]), (rails["l"], rails["cy"])])
    d.arrow([(stellar["cx"], stellar["b"]), (stellar["cx"], 452), (offchain["cx"], 452), (offchain["cx"], offchain["b"])], "one CCTP hop", lx=660, ly=452, dashed=True)
    d.arrow([(offchain["r"], offchain["cy"]), (bank["l"], bank["cy"])], dashed=True)
    d.text(600, 536, "Anchors settle on the hub itself, so the common payout path has no bridge in it. Dashed: naira, and the cctp.transfer leg, which is not built.", 11, 400, "muted", anchor="middle")
    d.save()


# =====================================================================
# FIG 04 · Corridor Reference
# =====================================================================
def reference():
    d = D("corridor-reference", 1200, 520, "Fig. 04 · Corridor Reference v2 · 32 bytes", "Byte layout of the 32-byte Corridor Reference and the fields that carry it on Stellar, on Solana and at an anchor")
    ref = "020114290001a1494e71ec7073bfffc84d758d67d2c6cf255f57adc6fd6cb505"
    bytes_ = [ref[i:i + 2] for i in range(0, 64, 2)]
    cw, x0, y0 = 34, 56, 92
    groups = [(0, 1, "version"), (1, 1, "kind"), (2, 1, "from"), (3, 1, "to"), (4, 1, "flags"), (5, 16, "payout id · UUIDv7"), (21, 7, "customer tag · keyed hash"), (28, 4, "checksum")]
    shade = {0: True, 1: False, 2: True, 3: False, 4: True, 5: False, 21: True, 28: False}
    for i, b in enumerate(bytes_):
        g = next(gs for gs in groups if gs[0] <= i < gs[0] + gs[1])
        inv = shade[g[0]]
        d.rect(x0 + i * cw, y0, cw - 2, 46, rx=4, inverted=inv)
        d.text(x0 + i * cw + (cw - 2) / 2, y0 + 28, b, 12, 700, "bg" if inv else "ink", anchor="middle")
        d.text(x0 + i * cw + (cw - 2) / 2, y0 + 62, str(i), 9, 400, "faint", anchor="middle")
    vals = {0: "0x02", 1: "payout", 2: "EUR", 3: "KES", 4: "public", 5: "01a1494e-71ec-7073-…", 21: "no PII on-chain", 28: "sha256[0..4] ✓"}
    for s, n, label in groups:
        gx0 = x0 + s * cw
        gx1 = x0 + (s + n) * cw - 2
        yb = y0 + 82 + (0 if n > 1 or s % 2 == 0 else 34)
        d.add(lambda t, gx0=gx0, gx1=gx1, yb=yb: f'<path d="M{gx0},{yb} L{gx0},{yb+6} L{gx1},{yb+6} L{gx1},{yb}" fill="none" stroke="{t["muted"]}" stroke-width="1"/>')
        cx = (gx0 + gx1) / 2
        d.text(cx, yb + 22, label, 10.5, 700, "ink", anchor="middle")
        d.text(cx, yb + 37, vals[s], 10, 400, "muted", anchor="middle")
    d.zone(32, 300, 1136, 180, "Carried in each venue's native field", "link")
    carriers = [("Stellar", "MEMO_HASH · 32 bytes exactly", "mark:stellar"), ("Solana", "SPL Memo corridor:<hex>", "mark:solana"),
                ("Anchor", "SEP-31 fields · bank narration", "webhook")]
    for i, (ti, sub, ic) in enumerate(carriers):
        n = d.node(56 + i * 372, 352, 352, ti, sub, ic)
        d.arrow([(n["cx"], 260 + 30), (n["cx"], n["t"])], head=True)
    d.text(600, 452, "Reconciliation is a join on these 32 bytes across Horizon payments, anchor orders and the ledger: no indexer stands in the path.", 11, 400, "muted", anchor="middle")
    d.save()


# =====================================================================
# FIG 05 · Payout EUR → KES (sequence)
# =====================================================================
def payout():
    d = D("payout-flow", 1200, 640, "Fig. 05 · Payout EUR → KES", "Numbered sequence of a EUR to KES payout across the ledger, the Stellar hub, the anchor and the beneficiary bank")
    lanes = [("Ledger", "customer balance", "database"), ("Stellar hub", "treasury vault", "mark:stellar"), ("Anchor", "SEP-31 · KES", "plug"), ("Beneficiary", "bank or mobile money", "landmark")]
    xs = [170, 470, 770, 1050]
    for (ti, sub, ic), x in zip(lanes, xs):
        d.node(x - 100, 64, 200, ti, sub, ic, inverted=(ti == "Stellar hub"))
        d.vline(x, 128, 600)
    steps = [
        (0, 0, 172, "reserve: available → hold"),
        (1, 2, 230, "SEP-10 auth · SEP-38 firm quote"),
        (1, 2, 288, "SEP-31 order → account + memo"),
        (1, 2, 346, "payment + MEMO_HASH (exactly once)"),
        (2, 3, 404, "KES paid to the account"),
        (2, 0, 462, "GET /transactions/{id}: completed"),
        (0, 0, 520, "book, then join on the memo"),
    ]
    for i, (a, b, y, label) in enumerate(steps, 1):
        if a == b:
            d.rect(xs[a] - 8, y - 14, 16, 28, rx=4, inverted=True)
            d.badge(xs[a] - 30, y, i)
            d.text(xs[a] + 20, y + 4, label, 11, 400, "ink")
        else:
            x0, x1 = xs[a], xs[b]
            d.arrow([(x0, y), (x1 - (8 if x1 > x0 else -8), y)])
            d.badge(x0 + (16 if x1 > x0 else -16), y, i)
            d.pill((x0 + x1) / 2 + (10 if x1 > x0 else 0), y - 16, label)
    d.text(600, 624, "Nothing stands between the customer's balance and the beneficiary's currency. The anchor assigns the funding memo, so the reference rides the SEP-31 fields.", 11, 400, "muted", anchor="middle")
    d.save()


# =====================================================================
# FIG 06 · The anchor handshake
# =====================================================================
def anchor_seps():
    d = D("anchor-seps", 1200, 620, "Fig. 06 · One anchor interface, five SEPs", "The SEP handshake between a Corridor vault and a Stellar anchor, from stellar.toml discovery to a polled SEP-31 payment")
    lanes = [("Corridor", "vault key · payout leg", "key-round"), ("Anchor", "its own licence and rails", "landmark")]
    xs = [300, 900]
    for (ti, sub, ic), x in zip(lanes, xs):
        d.node(x - 150, 64, 300, ti, sub, ic, inverted=(ti == "Corridor"))
        d.vline(x, 128, 560)
    steps = [
        (0, 1, 176, "SEP-1", "GET /.well-known/stellar.toml"),
        (1, 0, 228, "SEP-1", "endpoints · SIGNING_KEY · currencies"),
        (0, 1, 288, "SEP-10", "challenge checked, then signed"),
        (1, 0, 340, "SEP-10", "JWT, cached for its lifetime"),
        (0, 1, 400, "SEP-12", "sender and receiver records"),
        (0, 1, 452, "SEP-38", "firm quote, held for its life"),
        (0, 1, 504, "SEP-31", "order → receiving account + memo"),
    ]
    for i, (a, b, y, sep, label) in enumerate(steps, 1):
        x0, x1 = xs[a], xs[b]
        d.arrow([(x0, y), (x1 - (8 if x1 > x0 else -8), y)], dashed=(a == 1))
        d.badge(x0 + (26 if x1 > x0 else -26), y, i)
        d.pill((x0 + x1) / 2, y - 16, label)
        d.text(xs[1] + 170, y + 4, sep, 11, 700, "muted")
    d.rect(80, 560, 1040, 44, rx=10)
    d.text(100, 588, "The payment then carries the anchor's own memo, and the saga polls GET /transactions/{id}: SEP-31 has no webhook, and Corridor says so.", 11, 400, "muted")
    d.save()


# =====================================================================
# FIG 07 · Saga with compensation
# =====================================================================
def saga():
    d = D("saga-compensation", 1200, 480, "Fig. 07 · Saga with compensation", "Forward steps with a failure at the anchor, then compensation in reverse order including an on-chain refund on Stellar")
    steps = [("ledger.reserve", "available → hold", "book-open"), ("stellar leg", "treasury → escrow, same memo", "mark:stellar"), ("partner.payout", "fails before funding", "x")]
    xs = [80, 460, 840]
    nodes = [d.node(x, 190, 280, ti, sub, ic, dashed=(i == 2)) for i, ((ti, sub, ic), x) in enumerate(zip(steps, xs))]
    # forward
    d.text(80, 120, "Forward", 10.5, 400, "muted", spacing=1.6, upper=True)
    for i in range(2):
        a, b = nodes[i], nodes[i + 1]
        d.arrow([(a["r"], a["cy"] - 12), (b["l"], b["cy"] - 12)])
        d.badge((a["r"] + b["l"]) / 2, a["cy"] - 30, i + 1)
    d.badge(nodes[2]["cx"], nodes[2]["t"] - 22, "3")
    d.pill(nodes[2]["cx"] + 70, nodes[2]["t"] - 22, "fails")
    # compensation
    d.text(80, 372, "Compensation · reverse order", 10.5, 400, "muted", spacing=1.6, upper=True)
    comp = [(1, "refund escrow → treasury (on-chain)"), (0, "release hold → available")]
    prev = nodes[2]
    for k, (idx, label) in enumerate(comp):
        n = nodes[idx]
        d.arrow([(prev["cx"], prev["b"]), (prev["cx"], 300 + 12), (n["cx"], 300 + 12), (n["cx"], n["b"])], label,
                lx=(prev["cx"] + n["cx"]) / 2, ly=300 + 12 + 18, dashed=True)
        d.badge((prev["cx"] + n["cx"]) / 2 - len(label) * 3.3 - 26, 300 + 30, k + 4)
        prev = n
    # states
    states = ["running", "compensating", "compensated"]
    for i, s in enumerate(states):
        x = 360 + i * 180
        d.rect(x, 400, 150, 32, rx=16, inverted=(i == 2))
        d.text(x + 75, 420, s, 11, 700, "bg" if i == 2 else "ink", anchor="middle")
        if i:
            d.arrow([(x - 30, 416), (x - 2, 416)])
    d.text(600, 462, "Failure after the anchor was funded stops at manual_review instead: the money is at the anchor until its refund is confirmed.", 11, 400, "muted", anchor="middle")
    d.save()


# =====================================================================
# FIG 08 · Reconciliation
# =====================================================================
def recon():
    d = D("reconciliation", 1200, 560, "Fig. 08 · Reconciliation", "Observers on Horizon, anchor status and partner webhooks feed one observation stream into a matcher against the ledger, plus a vault balance check")
    d.zone(32, 64, 300, 400, "Observers", "radio-tower")
    obs = [("Horizon", "payments · memo · cursor", "mark:stellar"), ("Anchors", "SEP-31 status polling", "scan-search"), ("Partners", "signed webhooks", "webhook")]
    on = [d.node(52, 112 + i * 112, 260, ti, sub, ic) for i, (ti, sub, ic) in enumerate(obs)]
    stream = d.node(392, 224, 220, "Observation", "venue · ref · amount", "radio-tower")
    for n in on:
        d.curve((n["r"], n["cy"]), (stream["l"], stream["cy"]))
    matcher = d.node(672, 224, 200, "Matcher", "join on external ref", "scale", inverted=True)
    ledger = d.node(672, 360, 200, "Ledger", "bookings · 7 dp", "database")
    d.arrow([(stream["r"], stream["cy"]), (matcher["l"], matcher["cy"])])
    d.arrow([(ledger["cx"], ledger["t"]), (matcher["cx"], matcher["b"])], both=True)
    d.zone(912, 64, 256, 400, "Results", "circle-check")
    res = [("matched", "✓"), ("amount mismatch", "≠"), ("unbooked", "∅"), ("unreferenced", "?")]
    for i, (k, v) in enumerate(res):
        y = 112 + i * 56
        d.rect(932, y, 216, 44, rx=8, inverted=(i == 0))
        d.text(948, y + 27, k, 11, 400, "bg" if i == 0 else "muted")
        d.text(1132, y + 28, v, 16, 700, "bg" if i == 0 else "ink", anchor="end")
    d.arrow([(matcher["r"], matcher["cy"]), (932, 134)])
    # vault check
    d.rect(932, 352, 216, 92, rx=10)
    d.text(948, 376, "VAULT CHECK", 10, 400, "muted", spacing=1.6)
    d.text(948, 398, "on-chain balance, 7 dp", 10.5, 400, "ink")
    d.text(948, 414, "ledger balance, 7 dp", 10.5, 400, "ink")
    d.text(948, 434, "equal to the stroop", 10.5, 700, "ink")
    d.arrow([(ledger["r"], ledger["cy"]), (932, 398)], dashed=True)
    d.text(600, 520, "Stellar charges fees in XLM: each outbound transaction's fee is booked to expense:gas from the transaction that paid it, so a vault matches the books exactly.", 11, 400, "muted", anchor="middle")
    d.save()


for fn in (system, hub, topology, reference, payout, anchor_seps, saga, recon):
    fn()
