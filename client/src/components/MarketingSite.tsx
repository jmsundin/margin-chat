import { lazy, Suspense, useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { createDemoVault } from "../lib/demoVault";
import { AUTH_PATHS, MARKETING_PATHS, type MarketingPage } from "../lib/siteRoutes";
import {
  detectVisitorPlatform, downloadHref, fetchDesktopRelease, primaryDownload, readDownloadLinks, withDesktopRelease, PLATFORM_LABELS,
  type DownloadLinks, type VisitorPlatform,
} from "../lib/platform";
import "./MarketingSite.css";

// The live previews run the real map and document editor, so they load in their own chunk.
const loadLivePreviews = () => import("./landing/LivePreviews");
const LiveMapPreview = lazy(() => loadLivePreviews().then((module) => ({ default: module.LiveMapPreview })));
const LiveSideDocumentPreview = lazy(() => loadLivePreviews().then((module) => ({ default: module.LiveSideDocumentPreview })));

interface MarketingSiteProps {
  page: MarketingPage;
  signedIn: boolean;
  onNavigate(path: string): void;
  downloadLinks?: DownloadLinks;
  platform?: VisitorPlatform;
}

interface SiteContext {
  signedIn: boolean;
  links: DownloadLinks;
  platform: VisitorPlatform;
  webAppPath: string;
  go(event: MouseEvent<HTMLAnchorElement>): void;
}

export default function MarketingSite({ page, signedIn, onNavigate, downloadLinks, platform }: MarketingSiteProps) {
  const [published, setPublished] = useState<DownloadLinks | null>(null);
  // Which installers exist comes from the server, so a new desktop release
  // shows up without rebuilding the site.
  useEffect(() => {
    if (downloadLinks) return;
    let active = true;
    void fetchDesktopRelease().then((release) => {
      if (active && release) setPublished(withDesktopRelease(readDownloadLinks(), release));
    });
    return () => { active = false; };
  }, [downloadLinks]);
  const links = useMemo(() => downloadLinks ?? published ?? readDownloadLinks(), [downloadLinks, published]);
  const [visitorPlatform] = useState<VisitorPlatform>(() => platform ?? detectVisitorPlatform());
  useEffect(() => {
    const target = window.location.hash ? document.getElementById(window.location.hash.slice(1)) : null;
    if (target) target.scrollIntoView?.();
    else window.scrollTo?.(0, 0);
  }, [page]);

  const site: SiteContext = {
    signedIn,
    links,
    platform: visitorPlatform,
    webAppPath: signedIn ? "/" : AUTH_PATHS.signup,
    go(event) {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const href = event.currentTarget.getAttribute("href");
      if (!href?.startsWith("/")) return;
      event.preventDefault();
      onNavigate(href);
    },
  };

  return (
    <div className="mk">
      <SiteHeader page={page} site={site} />
      <main>
        {page === "home" ? <HomePage site={site} /> : page === "pricing" ? <PricingPage site={site} /> : <DownloadPage site={site} />}
      </main>
      <SiteFooter site={site} />
    </div>
  );
}

function Logo() {
  return (
    <svg width="28" height="28" viewBox="0 0 512 512" aria-hidden="true">
      <rect width="512" height="512" rx="110" fill="#f4ecdf" />
      <path d="M147 158h106v89h-48v105h-58z" fill="#a94b32" />
      <path d="M253 202h62v150h-62z" fill="#2e5947" />
      <path d="M303 274h62v78h-62z" fill="#2e5947" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m5 12 5 5L20 7" />
    </svg>
  );
}

function SiteHeader({ page, site }: { page: MarketingPage; site: SiteContext }) {
  const current = (target: MarketingPage) => (page === target ? "page" : undefined);
  return (
    <header className="mk-header">
      <div className="mk-wrap mk-header-row">
        <a className="mk-brand" href={MARKETING_PATHS.home} onClick={site.go}>
          <Logo /><span>Margin Chat</span>
        </a>
        <nav className="mk-nav" aria-label="Main">
          <a className="mk-hide-sm" href="/#features" onClick={page === "home" ? undefined : site.go}>Features</a>
          <a href={MARKETING_PATHS.pricing} onClick={site.go} aria-current={current("pricing")}>Pricing</a>
          <a href={MARKETING_PATHS.download} onClick={site.go} aria-current={current("download")}>Download</a>
          {site.signedIn ? (
            <a className="mk-btn mk-btn-primary mk-btn-sm" href="/" onClick={site.go}>Open Margin Chat</a>
          ) : (
            <>
              <a href={AUTH_PATHS.login} onClick={site.go}>Log in</a>
              <a className="mk-btn mk-btn-primary mk-btn-sm" href={AUTH_PATHS.signup} onClick={site.go}>Get started</a>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}

function PrimaryActions({ site }: { site: SiteContext }) {
  const primary = primaryDownload(site.platform, site.links);
  return (
    <>
      <div className="mk-actions">
        {primary.kind === "desktop" ? (
          <a className="mk-btn mk-btn-primary mk-btn-lg" href={downloadHref(primary.href ?? "", "hero")}><DownloadIcon />{primary.label}</a>
        ) : (
          <a className="mk-btn mk-btn-primary mk-btn-lg" href={site.webAppPath} onClick={site.go}>{site.signedIn ? "Open Margin Chat" : primary.label}</a>
        )}
        {primary.kind === "desktop" ? (
          <a className="mk-btn mk-btn-ghost mk-btn-lg" href={site.webAppPath} onClick={site.go}>Open in your browser</a>
        ) : (
          <a className="mk-btn mk-btn-ghost mk-btn-lg" href={MARKETING_PATHS.pricing} onClick={site.go}>See pricing</a>
        )}
      </div>
      <p className="mk-action-note">
        {primary.note} <a href={MARKETING_PATHS.download} onClick={site.go}>Other platforms</a>
      </p>
    </>
  );
}

function AppPreview() {
  return (
    <div className="mk-preview" role="img" aria-label="Margin Chat with a note open and a branch in the margin about a highlighted sentence">
      <div className="mk-preview-bar" aria-hidden="true">
        <span /><span /><span />
        <em>Vault › Reading › The printing press</em>
      </div>
      <div className="mk-preview-body" aria-hidden="true">
        <div className="mk-preview-side">
          <div className="mk-preview-label">VAULT</div>
          <div>Inbox</div>
          <div className="is-active">The printing press</div>
          <div className="is-child">↳ Movable type in Korea</div>
          <div className="is-child">↳ Who could read in 1500?</div>
          <div>Reformation</div>
          <div>Gutenberg Bible</div>
          <div>Information overload</div>
        </div>
        <div className="mk-preview-doc">
          <h3>The printing press</h3>
          <p>Before Gutenberg, a book was copied by hand and a large library held a few hundred volumes. Within fifty years of his press, Europe had printed something like twenty million books, and <mark>the number of people who could check a claim against a source</mark> grew with it.</p>
          <p className="is-muted">The change was less about speed than about copies being identical, which made it possible to cite page and line…</p>
        </div>
        <div className="mk-preview-margin">
          <div className="mk-preview-label is-accent">BRANCH · FROM YOUR HIGHLIGHT</div>
          <div className="mk-bubble">Who actually could read in 1500, and how do we know?</div>
          <p>Estimates come from signatures on marriage registers and court records. In England, perhaps one man in ten could sign his name around 1500…</p>
          <div className="mk-chips"><span>Save as child note</span><span>Back to main thread</span></div>
        </div>
      </div>
    </div>
  );
}

const MAP_NODES = [
  { label: "The printing press", x: 50, y: 50, kind: "center" },
  { label: "Gutenberg Bible", x: 27, y: 27, kind: "note" },
  { label: "Who could read in 1500?", x: 30, y: 76, kind: "note" },
  { label: "Reformation", x: 73, y: 25, kind: "linked" },
  { label: "Information overload", x: 76, y: 74, kind: "linked" },
  { label: "+ Movable type (Wikipedia)", x: 12, y: 48, kind: "suggested" },
  { label: "+ Martin Luther", x: 90, y: 49, kind: "suggested" },
  { label: "+ Ask AI: Literacy", x: 13, y: 86, kind: "suggested" },
] as const;
const MAP_EDGES: [number, number][] = [[0, 1], [0, 2], [0, 3], [0, 4], [1, 5], [3, 6], [4, 6], [2, 7]];

function MapPreview() {
  return (
    <div className="mk-map" role="img" aria-label="A map of linked notes around The printing press, with suggested topics from Wikipedia and Ask AI">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        {MAP_EDGES.map(([from, to]) => (
          <line key={`${from}-${to}`} x1={MAP_NODES[from].x} y1={MAP_NODES[from].y} x2={MAP_NODES[to].x} y2={MAP_NODES[to].y} vectorEffect="non-scaling-stroke" />
        ))}
      </svg>
      {MAP_NODES.map((node) => (
        <span key={node.label} className={`mk-map-node is-${node.kind}`} style={{ left: `${node.x}%`, top: `${node.y}%` }} aria-hidden="true">{node.label}</span>
      ))}
      <div className="mk-map-modes" aria-hidden="true"><span className="is-active">Canvas</span><span>Focus</span><span>Clusters</span></div>
    </div>
  );
}

function Feature({ eyebrow, tone, title, children, visual, reverse }: { eyebrow: string; tone: string; title: string; children: ReactNode; visual: ReactNode; reverse?: boolean }) {
  return (
    <section className="mk-section">
      <div className={reverse ? "mk-wrap mk-split is-reverse" : "mk-wrap mk-split"}>
        <div>
          <p className={`mk-eyebrow is-${tone}`}>{eyebrow}</p>
          <h2 className="mk-h2">{title}</h2>
          {children}
        </div>
        {visual}
      </div>
    </section>
  );
}

function HomePage({ site }: { site: SiteContext }) {
  // One sample vault feeds both live previews, so a side document made in one shows up on the map.
  const [vault, setVault] = useState(createDemoVault);
  return (
    <>
      <section className="mk-hero">
        <div className="mk-wrap">
          <p className="mk-eyebrow is-sage">FOR MAC, THE WEB AND CHROME</p>
          <h1 className="mk-h1">Think in the margins.</h1>
          <p className="mk-lede">Chat with AI, branch off any passage without losing your place, and keep every idea as a Markdown note you own. Then see how it all connects on a map.</p>
          <PrimaryActions site={site} />
        </div>
        <div className="mk-wrap mk-hero-preview"><AppPreview /></div>
      </section>

      <section className="mk-section is-roomy">
        <div className="mk-wrap">
          <h2 className="mk-h2 is-wide">Chats scroll away. Ideas shouldn’t.</h2>
          <p className="mk-body is-intro">A normal AI chat is one long line. Every tangent pushes the original question further up the page, and the good answers end up buried in a history you never reopen. Margin Chat gives each tangent its own place and keeps all of it.</p>
          <div className="mk-grid3">
            <div className="mk-point is-coral"><h3>Branch, don’t scroll</h3><p>Highlight a sentence and ask about it in the margin. The main conversation stays exactly where you left it.</p></div>
            <div className="mk-point is-sage"><h3>Keep what you learn</h3><p>Every chat and branch is a Markdown file in your vault, linked to where it came from.</p></div>
            <div className="mk-point is-violet"><h3>See the shape of it</h3><p>Open the map and your notes become a graph you can arrange, cluster and grow.</p></div>
          </div>
        </div>
      </section>

      <section className="mk-section" id="features">
        <div className="mk-wrap">
          <p className="mk-eyebrow is-coral">BRANCHES AND NOTES</p>
          <div className="mk-split is-tight">
            <h2 className="mk-h2">Follow a tangent without losing your place.</h2>
            <p className="mk-body">Select any passage and open a side document beside it, linked to the words you highlighted. The original stays exactly where you left it. Try it below: this is the real editor, running on a sample vault in your browser.</p>
          </div>
          <Suspense fallback={<div className="mk-live-loading" role="status">Loading the live preview…</div>}>
            <LiveSideDocumentPreview vault={vault} setVault={setVault} />
          </Suspense>
          <p className="mk-live-caption">Nothing here is saved or sent anywhere. Reload the page to start over.</p>
        </div>
      </section>

      <Feature
        eyebrow="YOUR VAULT"
        tone="sage"
        title="Plain Markdown, on your own disk."
        reverse
        visual={(
          <pre className="mk-panel mk-code" aria-label="Example note file">
            <span className="is-muted">~/Vault/Reading/who-could-read-in-1500.md</span>{"\n\n"}
            <span className="is-sage">---</span>{"\n"}
            parent: <span className="is-coral">"[[The printing press]]"</span>{"\n"}
            related:{"\n"}
            {"  - "}<span className="is-coral">"[[Reformation]]"</span>{"\n"}
            source: chat{"\n"}
            <span className="is-sage">---</span>{"\n"}
            <span className="is-ink"># Who could read in 1500?</span>{"\n"}
            Signatures on marriage registers suggest…{"\n\n"}
            {"```mermaid\ngraph LR; Press-->Books-->Readers\n```"}
          </pre>
        )}
      >
        <p className="mk-body">Point Margin Chat at a folder and your notes stay ordinary files you can open in any editor. Links between notes are written as wikilinks in the frontmatter, so the connections travel with the files.</p>
        <ul className="mk-list">
          <li>Live Preview editor with Mermaid diagrams</li>
          <li>Video and YouTube embeds with clickable timestamps</li>
          <li>Optional cloud vault so your notes are on every device</li>
        </ul>
      </Feature>

      <section className="mk-section" id="maps">
        <div className="mk-wrap">
          <p className="mk-eyebrow is-violet">MAPS</p>
          <div className="mk-split is-tight">
            <h2 className="mk-h2">See how your ideas connect, then grow the map.</h2>
            <p className="mk-body">The map draws every note and link in your vault. Search a topic to pull in its Wikipedia article and related pages, or ask AI to suggest what belongs next to it.</p>
          </div>
          <Suspense fallback={<MapPreview />}>
            <LiveMapPreview vault={vault} setVault={setVault} />
          </Suspense>
          <p className="mk-live-caption">This is the real Map view. Drag the canvas, zoom, switch between Canvas, Focus and Clusters, and open a card to read it. Side documents you created above appear here too.</p>
          <div className="mk-grid3 is-compact">
            <div><h3 className="mk-h3">Canvas</h3><p className="mk-body">Place notes where you want them, drag to arrange, and tidy up in one click.</p></div>
            <div><h3 className="mk-h3">Focus</h3><p className="mk-body">Center one note and see only what it links to and from.</p></div>
            <div><h3 className="mk-h3">Clusters</h3><p className="mk-body">Group notes by their links or by your own groups, even across thousands of notes.</p></div>
          </div>
        </div>
      </section>

      <section className="mk-section">
        <div className="mk-wrap">
          <h2 className="mk-h2">And the rest of the toolkit</h2>
          <div className="mk-grid3">
            <div className="mk-panel mk-card"><h3 className="mk-h3">Agent mode</h3><p className="mk-body">Switch Ask AI to Agent and it works through your notes on its own, showing each step it takes.</p></div>
            <div className="mk-panel mk-card"><h3 className="mk-h3">Search that shows the passage</h3><p className="mk-body">Results open as rendered previews with your search terms highlighted, so you find the line, not just the file.</p></div>
            <div className="mk-panel mk-card"><h3 className="mk-h3">Titles that write themselves</h3><p className="mk-body">New chats and notes get a short, sensible title automatically, so your vault stays readable.</p></div>
          </div>
        </div>
      </section>

      <section className="mk-section">
        <div className="mk-wrap">
          <h2 className="mk-h2">Wherever you read</h2>
          <p className="mk-body is-intro">One account, the same vault, four ways in.</p>
          <div className="mk-grid4">
            <a className="mk-panel mk-card mk-card-link" href={MARKETING_PATHS.download} onClick={site.go}><strong>Desktop app</strong><span>{site.links.mac || site.links.windows || site.links.linux ? "macOS, Windows and Linux." : "Coming soon."}</span></a>
            <a className="mk-panel mk-card mk-card-link" href={site.webAppPath} onClick={site.go}><strong>Web</strong><span>Any modern browser, nothing to install.</span></a>
            <a className="mk-panel mk-card mk-card-link" href={MARKETING_PATHS.download} onClick={site.go}><strong>Chrome extension</strong><span>Chat beside any web page in a docked panel.</span></a>
            <a className="mk-panel mk-card mk-card-link" href={site.webAppPath} onClick={site.go}><strong>Phone</strong><span>Swipe for the sidebar, pull down to search.</span></a>
          </div>
        </div>
      </section>

      <section className="mk-section">
        <div className="mk-wrap mk-split is-top">
          <div>
            <h2 className="mk-h2">Simple pricing</h2>
            <p className="mk-body">Start free with your own AI keys. Upgrade when you want us to run the models and keep your vault in the cloud.</p>
            <p><a className="mk-strong-link" href={MARKETING_PATHS.pricing} onClick={site.go}>See full pricing →</a></p>
          </div>
          <div className="mk-grid2">
            <div className="mk-plan-mini"><strong>Free</strong><span className="mk-price">$0</span><span>Your own API keys. Local vault.</span></div>
            <div className="mk-plan-mini is-featured"><strong>Plus</strong><span className="mk-price">$20<small>/mo</small></span><span>Includes $20 of AI credit every month. Cloud vault.</span></div>
          </div>
        </div>
      </section>

      <section className="mk-section is-cta">
        <div className="mk-wrap">
          <h2 className="mk-h1 is-cta">Your next tangent deserves a margin.</h2>
          <PrimaryActions site={site} />
        </div>
      </section>
    </>
  );
}

const PLUS_FEATURES = [
  <><strong>$20 of AI credit every month</strong>, which rolls over</>,
  "No API keys needed: hosted Claude and GPT models",
  "Cloud vault, so your notes are on every device",
  "Agent mode in Ask AI",
  "Everything in Free",
];
const FREE_FEATURES = [
  "Branches, notes, maps and search",
  "Local Markdown vault on your computer",
  "Use your own OpenAI, Anthropic or Gemini API keys",
  "Mac app, web, Chrome extension and phone",
];
const COMPARE_ROWS: [string, string, string][] = [
  ["Branches, notes, maps, search", "Yes", "Yes"],
  ["Local Markdown vault", "Yes", "Yes"],
  ["Cloud vault", "No", "Yes"],
  ["AI with your own API keys", "Yes", "Yes"],
  ["Hosted AI, no keys needed", "With top-up credit", "$20 of credit each month"],
  ["Mac app, web, Chrome, phone", "Yes", "Yes"],
];
const FAQ: [string, string][] = [
  ["How is AI usage charged?", "Each request costs what the model provider charges for its tokens, taken from your credit. You can see every charge under Billing in your profile."],
  ["What happens to unused credit?", "It rolls over to the next month, and you keep it if you cancel."],
  ["Do my own API keys use credit?", "No. Requests made with your own keys are billed by your provider and never touch your Margin Chat credit."],
  ["Where are my notes stored?", "In a folder on your computer by default. Plus adds a cloud vault so the same notes are on every device."],
  ["Can I cancel any time?", "Yes, from Billing in your profile. Plus stays active until the end of the period you paid for."],
  ["Can I add credit without subscribing?", "Yes. Top-ups from $5 to $500 work with or without Plus."],
];

function PricingPage({ site }: { site: SiteContext }) {
  return (
    <>
      <section className="mk-page-head">
        <div className="mk-wrap">
          <h1 className="mk-h1 is-page">Pay for the AI you use</h1>
          <p className="mk-lede">Margin Chat is free with your own API keys. Plus runs the models for you and turns your subscription into AI credit, dollar for dollar.</p>
        </div>
      </section>
      <section>
        <div className="mk-wrap mk-wrap-narrow mk-grid2 is-plans">
          <div className="mk-plan">
            <div><h2 className="mk-h3">Free</h2><p className="mk-muted">For people who bring their own keys</p></div>
            <div className="mk-price is-large">$0</div>
            <a className="mk-btn mk-btn-ghost" href={site.webAppPath} onClick={site.go}>{site.signedIn ? "Open Margin Chat" : "Get started"}</a>
            <ul className="mk-checks">{FREE_FEATURES.map((item) => <li key={item}><CheckIcon />{item}</li>)}</ul>
          </div>
          <div className="mk-plan is-featured">
            <div><h2 className="mk-h3">Plus</h2><p className="mk-muted">Hosted AI and a cloud vault</p></div>
            <div><span className="mk-price is-large">$20</span><span className="mk-muted"> / month</span></div>
            <a className="mk-btn mk-btn-primary" href={site.webAppPath} onClick={site.go}>{site.signedIn ? "Upgrade in Billing" : "Start with Plus"}</a>
            <ul className="mk-checks">{PLUS_FEATURES.map((item, index) => <li key={index}><CheckIcon /><span>{item}</span></li>)}</ul>
          </div>
        </div>
      </section>
      <section className="mk-section is-short">
        <div className="mk-wrap mk-wrap-narrow">
          <div className="mk-panel mk-topup">
            <div>
              <h2 className="mk-h3">Need more? Top up any time.</h2>
              <p className="mk-body">Add $5 to $500 of credit in one payment, with or without Plus. Credit stays yours if you cancel.</p>
            </div>
          </div>
        </div>
      </section>
      <section className="mk-section is-short">
        <div className="mk-wrap mk-wrap-narrow">
          <h2 className="mk-h2">Compare plans</h2>
          <div className="mk-table-box">
            <table className="mk-table">
              <thead><tr><th scope="col">Feature</th><th scope="col">Free</th><th scope="col">Plus</th></tr></thead>
              <tbody>{COMPARE_ROWS.map(([feature, free, plus]) => <tr key={feature}><th scope="row">{feature}</th><td>{free}</td><td>{plus}</td></tr>)}</tbody>
            </table>
          </div>
        </div>
      </section>
      <section className="mk-section is-short is-last">
        <div className="mk-wrap mk-wrap-narrow">
          <h2 className="mk-h2">Questions</h2>
          <dl className="mk-faq">
            {FAQ.map(([question, answer]) => <div key={question}><dt>{question}</dt><dd>{answer}</dd></div>)}
          </dl>
        </div>
      </section>
    </>
  );
}

const DOWNLOAD_TABS = ["mac", "windows", "linux", "ios", "android"] as const;
type DownloadTab = (typeof DOWNLOAD_TABS)[number];

function tabForPlatform(platform: VisitorPlatform): DownloadTab {
  if (platform === "chromeos" || platform === "unknown") return "linux";
  return platform;
}

function DownloadPage({ site }: { site: SiteContext }) {
  const detected = tabForPlatform(site.platform);
  const [tab, setTab] = useState<DownloadTab>(detected);
  const { links } = site;
  const extension = links.chromeExtension
    ? <a className="mk-btn mk-btn-ghost mk-btn-lg" href={links.chromeExtension}>Add to Chrome</a>
    : null;
  const webApp = (label = "Open the web app", tone = "primary") => <a className={`mk-btn mk-btn-${tone} mk-btn-lg`} href={site.webAppPath} onClick={site.go}>{label}</a>;

  let title: string;
  let body: string;
  let actions: ReactNode;
  // The installers are not code-signed yet, so the system warns on first open.
  let firstOpen: string | null = null;
  const version = links.desktopVersion ? ` Version ${links.desktopVersion}.` : "";
  const installer = (href: string, label: string, tone = "primary") => <a className={`mk-btn mk-btn-${tone} mk-btn-lg`} href={downloadHref(href, "download-page")}><DownloadIcon />{label}</a>;
  if (tab === "mac" && links.mac) {
    title = "Margin Chat for macOS";
    body = `The desktop app keeps your vault on your Mac and tells you when an update is ready. Runs on Apple Silicon and Intel.${version}`;
    actions = <>{installer(links.mac, "Download for macOS")}{webApp("Open in your browser", "ghost")}</>;
    firstOpen = "First time you open it, macOS may say it can’t check the app. Open System Settings, then Privacy & Security, and choose Open Anyway.";
  } else if (tab === "windows" && links.windows) {
    title = "Margin Chat for Windows";
    body = `The desktop app keeps your vault on your PC and tells you when an update is ready. For 64-bit Windows 10 and 11.${version}`;
    actions = <>{installer(links.windows, "Download for Windows")}{webApp("Open in your browser", "ghost")}</>;
    firstOpen = "If Windows shows “Windows protected your PC”, choose More info, then Run anyway.";
  } else if (tab === "linux" && (links.linux || links.linuxDeb)) {
    title = "Margin Chat for Linux";
    body = `The AppImage runs on most distributions; the .deb installs on Debian, Ubuntu and ChromeOS Linux. For 64-bit Intel and AMD.${version}`;
    actions = <>
      {links.linux && installer(links.linux, "Download AppImage")}
      {links.linuxDeb && installer(links.linuxDeb, "Download .deb", links.linux ? "ghost" : "primary")}
    </>;
    firstOpen = "Make the AppImage executable (right-click, Properties, or chmod +x) before you run it.";
  } else if (tab === "ios" || tab === "android") {
    title = `Margin Chat on ${PLATFORM_LABELS[tab]}`;
    body = tab === "ios"
      ? "Open it in Safari, tap Share, then Add to Home Screen. Swipe for the sidebar and pull down to search."
      : "Open it in Chrome, then choose Add to Home screen. Swipe for the sidebar and pull down to search.";
    actions = webApp();
  } else {
    title = `The ${PLATFORM_LABELS[tab]} app is on its way`;
    body = "Everything works in your browser today, with your vault and maps exactly as they are in the app.";
    actions = <>{webApp()}{extension}</>;
  }

  return (
    <>
      <section className="mk-page-head">
        <div className="mk-wrap">
          <h1 className="mk-h1 is-page">Download Margin Chat</h1>
          <p className="mk-lede">We picked the version for your device. Choose another if that’s not right.</p>
          <div className="mk-os-tabs" role="tablist" aria-label="Operating system">
            {DOWNLOAD_TABS.map((option) => (
              <button
                key={option}
                type="button"
                role="tab"
                id={`mk-os-${option}`}
                aria-selected={tab === option}
                aria-controls="mk-os-panel"
                className={tab === option ? "mk-os-tab is-active" : "mk-os-tab"}
                onClick={() => setTab(option)}
              >
                {option === "ios" ? "iPhone" : PLATFORM_LABELS[option]}
              </button>
            ))}
          </div>
          <div className="mk-panel mk-os-panel" id="mk-os-panel" role="tabpanel" aria-labelledby={`mk-os-${tab}`}>
            {tab === detected && site.platform !== "unknown" && <p className="mk-muted">Looks like you’re on {PLATFORM_LABELS[site.platform]}</p>}
            <h2 className="mk-h2">{title}</h2>
            <p className="mk-body">{body}</p>
            <div className="mk-actions">{actions}</div>
            {firstOpen && <p className="mk-muted">{firstOpen}</p>}
          </div>
        </div>
      </section>
      <section className="mk-section is-short is-last">
        <div className="mk-wrap">
          <h2 className="mk-h2">All ways to use Margin Chat</h2>
          <div className="mk-grid3">
            <PlatformCard title="macOS" detail={links.mac ? "Apple Silicon and Intel" : "Coming soon"}>
              {links.mac ? <a href={downloadHref(links.mac, "download-list")}>Download (.dmg)</a> : <span className="mk-muted">Use the web app until it’s ready.</span>}
            </PlatformCard>
            <PlatformCard title="Web app" detail="Chrome, Edge, Safari, Firefox">
              <a href={site.webAppPath} onClick={site.go}>Open marginchat.com</a>
              <span className="mk-muted">Folder vaults need Chrome or Edge.</span>
            </PlatformCard>
            <PlatformCard title="Chrome extension" detail={links.chromeExtension ? "Chrome and Chromium browsers" : "Coming soon to the Chrome Web Store"}>
              {links.chromeExtension ? <a href={links.chromeExtension}>Add to Chrome</a> : null}
              <span className="mk-muted">Chat beside any page in a docked panel.</span>
            </PlatformCard>
            <PlatformCard title="Windows" detail={links.windows ? "Windows 10 and 11, 64-bit" : "Coming soon"}>
              {links.windows ? <a href={downloadHref(links.windows, "download-list")}>Download (.exe)</a> : <span className="mk-muted">Use the web app today.</span>}
            </PlatformCard>
            <PlatformCard title="Linux" detail={links.linux || links.linuxDeb ? "64-bit Intel and AMD" : "Coming soon"}>
              {links.linux && <a href={downloadHref(links.linux, "download-list")}>Download (AppImage)</a>}
              {links.linuxDeb && <a href={downloadHref(links.linuxDeb, "download-list")}>Download (.deb)</a>}
              {!links.linux && !links.linuxDeb && <span className="mk-muted">Use the web app today.</span>}
            </PlatformCard>
            <PlatformCard title="iPhone and Android" detail="In your phone’s browser">
              <a href={site.webAppPath} onClick={site.go}>Open the web app</a>
              <span className="mk-muted">Add it to your Home Screen for a full-screen app.</span>
            </PlatformCard>
          </div>
        </div>
      </section>
    </>
  );
}

function PlatformCard({ title, detail, children }: { title: string; detail: string; children: ReactNode }) {
  return (
    <div className="mk-panel mk-card mk-platform">
      <h3 className="mk-h3">{title}</h3>
      <span className="mk-muted">{detail}</span>
      {children}
    </div>
  );
}

function SiteFooter({ site }: { site: SiteContext }) {
  return (
    <footer className="mk-footer">
      <div className="mk-wrap mk-footer-grid">
        <div><strong className="mk-footer-brand">Margin Chat</strong><p className="mk-muted">Think in the margins.</p></div>
        <nav aria-label="Product">
          <strong>Product</strong>
          <a href={MARKETING_PATHS.home} onClick={site.go}>Overview</a>
          <a href={MARKETING_PATHS.pricing} onClick={site.go}>Pricing</a>
          <a href={MARKETING_PATHS.download} onClick={site.go}>Download</a>
        </nav>
        <nav aria-label="Account">
          <strong>Account</strong>
          {site.signedIn ? <a href="/" onClick={site.go}>Open Margin Chat</a> : (
            <>
              <a href={AUTH_PATHS.login} onClick={site.go}>Log in</a>
              <a href={AUTH_PATHS.signup} onClick={site.go}>Sign up</a>
            </>
          )}
        </nav>
      </div>
    </footer>
  );
}
