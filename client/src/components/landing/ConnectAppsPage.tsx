import { useState, type MouseEvent, type ReactNode } from "react";
import { MCP_SERVER_URL } from "../../lib/siteRoutes";

const REPO = "https://github.com/jmsundin/margin-chat/blob/main";
const TOKEN = "YOUR_TOKEN";

interface ConnectAppsPageProps {
  webAppPath: string;
  signedIn: boolean;
  go(event: MouseEvent<HTMLAnchorElement>): void;
}

function CopyCode({ code, label }: { code: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mk-panel mk-connect-code">
      <pre aria-label={label}>{code}</pre>
      <button
        type="button"
        className="mk-connect-copy"
        onClick={() => { void navigator.clipboard?.writeText(code).then(() => setCopied(true), () => undefined); }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

interface AppGuide {
  id: string;
  name: string;
  how: "Sign in" | "Token" | "Token or sign in";
  saves: string;
  intro: ReactNode;
  steps: ReactNode[];
  after?: ReactNode;
}

const claudeCodeCommand = `claude mcp add --scope user --transport http margin-chat ${MCP_SERVER_URL} \\
  --header "Authorization: Bearer ${TOKEN}"`;
const cursorConfig = JSON.stringify({ mcpServers: { "margin-chat": { url: MCP_SERVER_URL, headers: { Authorization: `Bearer ${TOKEN}` } } } }, null, 2);
const vscodeConfig = JSON.stringify({ servers: { "margin-chat": { type: "http", url: MCP_SERVER_URL, headers: { Authorization: `Bearer ${TOKEN}` } } } }, null, 2);
const musePrompt = `Build a custom connector to the MCP server at ${MCP_SERVER_URL}. Auth is a Bearer API key.`;

const consentStep = <>Margin Chat opens and asks <strong>Connect … to your vault?</strong> Sign in if you need to. Leave <strong>Also let it create documents</strong> ticked if the app should save to your vault, then choose <strong>Connect</strong>.</>;

const GUIDES: AppGuide[] = [
  {
    id: "claude",
    name: "Claude apps",
    how: "Sign in",
    saves: "Yes",
    intro: <>Claude on the web, the desktop app and the phone app share one connector. Custom connectors work on every Claude plan; the Free plan allows one. On Team and Enterprise plans an owner adds it for the organization first.</>,
    steps: [
      <>Open <a href="https://claude.ai/customize/connectors">claude.ai → Customize → Connectors</a>. In the desktop app, choose <strong>Customize</strong> in the sidebar, then <strong>Connectors</strong>.</>,
      <>Choose <strong>Add custom connector</strong>. Name it “Margin Chat” and paste the server address.</>,
      <>Choose <strong>Add</strong>, then <strong>Connect</strong>.</>,
      consentStep,
    ],
    after: <>It now works in every Claude app you sign in to. The first time Claude wants to use a Margin Chat tool it may ask you to allow it.</>,
  },
  {
    id: "claude-code",
    name: "Claude Code",
    how: "Token",
    saves: "Yes",
    intro: <>Make a token named “Claude Code” first. <code>--scope user</code> below makes Margin Chat available in every folder, not just the one you’re in.</>,
    steps: [
      <>Run this once in a terminal:<CopyCode code={claudeCodeCommand} label="Claude Code command" /></>,
      <>Replace <code>{TOKEN}</code> with your token, start <code>claude</code> and type <code>/mcp</code>. <strong>margin-chat</strong> should show as connected.</>,
    ],
    after: <>Want every session saved without asking? <a href={`${REPO}/docs/claude-code-autosave.md`}>Save Claude Code sessions automatically</a> adds a hook that files each session in your vault, grouped by project.</>,
  },
  {
    id: "chatgpt",
    name: "ChatGPT",
    how: "Sign in",
    saves: "Business, Enterprise and Edu only",
    intro: <>On Plus and Pro, OpenAI lets custom connectors search and read but not save. Saving needs a Business, Enterprise or Edu workspace whose admin allows it. Custom connectors aren’t available on the Free plan.</>,
    steps: [
      <>On <a href="https://chatgpt.com">chatgpt.com</a>, open <strong>Settings → Security and login</strong> and turn on <strong>Developer mode</strong>.</>,
      <>Open <a href="https://chatgpt.com/plugins">Settings → Plugins</a>, choose <strong>+</strong>, then <strong>Add custom MCP server</strong>.</>,
      <>Name it “Margin Chat”, paste the server address, pick OAuth for sign-in, accept the warning and choose <strong>Create</strong>.</>,
      consentStep,
    ],
    after: <>In a chat, type <strong>@</strong> and pick Margin Chat. Your old ChatGPT chats can come in too: export them from ChatGPT, then use <strong>Bring your chat history</strong> in Margin Chat.</>,
  },
  {
    id: "gemini",
    name: "Gemini",
    how: "Sign in",
    saves: "Yes, if your account can use custom apps",
    intro: <>Google offers custom apps to personal Google accounts in the US, in English, with Keep Activity on and access to Gemini Spark. Work and school accounts can’t add them yet.</>,
    steps: [
      <>On a computer, open <a href="https://gemini.google.com">gemini.google.com</a>, then <strong>Settings → Connected Apps</strong> at the bottom left.</>,
      <>Under <strong>Custom apps for Spark</strong>, choose <strong>Add a custom app</strong> and paste the server address.</>,
      consentStep,
    ],
    after: <>Use it from Gemini Spark or in a chat. Gemini asks you to confirm before it saves anything. If Gemini reports a connection error such as “Transport for env PROD not found”, the error is inside Gemini: remove Margin Chat under Connected Apps, add it again, and approve it once more. <strong>Profile → Agents</strong> in Margin Chat shows whether Gemini signed in and when it last reached your vault.</>,
  },
  {
    id: "muse",
    name: "Meta Muse",
    how: "Token",
    saves: "Yes",
    intro: <>Make a token named “Muse” first. Muse builds the connector itself when you ask.</>,
    steps: [
      <>Send Muse this message:<CopyCode code={musePrompt} label="Message for Muse" /></>,
      <>When Muse asks for the key, paste your token into its secure credential box, never into the chat.</>,
      <>Ask “Search my Margin Chat vault for …” to check that it works.</>,
    ],
    after: <>Use the <code>www.</code> address exactly as shown. Muse won’t follow the redirect from marginchat.com.</>,
  },
  {
    id: "muse-code",
    name: "Muse Code",
    how: "Token or sign in",
    saves: "Yes",
    intro: <>Meta’s coding agent can reuse what you set up for Claude Code.</>,
    steps: [
      <>If Claude Code already has Margin Chat, run <code>/migrate</code> inside Muse Code to copy its MCP servers over.</>,
      <>Otherwise add a Streamable HTTP server named <code>margin-chat</code> with the server address and the header <code>Authorization: Bearer {TOKEN}</code>, or sign in with <code>muse mcp login margin-chat</code>.</>,
      <>Type <code>/mcp</code> to check that it’s connected.</>,
    ],
  },
  {
    id: "cursor",
    name: "Cursor",
    how: "Token",
    saves: "Yes",
    intro: <>Add Margin Chat to <code>~/.cursor/mcp.json</code> for every project, or <code>.cursor/mcp.json</code> for one.</>,
    steps: [<CopyCode key="code" code={cursorConfig} label="Cursor configuration" />],
  },
  {
    id: "vscode",
    name: "VS Code",
    how: "Token",
    saves: "Yes",
    intro: <>Add Margin Chat to <code>.vscode/mcp.json</code> in your project, or run <strong>MCP: Open User Configuration</strong> for every project. VS Code uses <code>servers</code>, not <code>mcpServers</code>.</>,
    steps: [<CopyCode key="code" code={vscodeConfig} label="VS Code configuration" />],
  },
];

const PROMPTS = [
  "Save a summary of this chat to Margin Chat.",
  "What do my Margin Chat notes say about rapamycin?",
  "Add these findings to the end of my “Longevity reading list” document.",
  "Search my vault for what I’ve read on mTOR and tell me what’s missing.",
];

const FAQ: [string, ReactNode][] = [
  ["Can an AI app change or delete my notes?", "No. It can search and read, and with your permission create new documents and add to the end of existing ones. Nothing is ever replaced or deleted."],
  ["Which documents can it see?", <>Everything in your cloud vault except documents you hide from AI. Open a document’s menu and tick <strong>Hide from AI</strong> to keep it out of every AI app, Ask AI and Agent mode.</>],
  ["Where do saved documents go?", "New documents appear at the top of your vault, named after their title and labelled with the token or app that made them. Open apps pick them up within about 15 seconds."],
  ["Which plans can connect?", "Plus and Cloud. The server reads your cloud vault, so it can’t reach a vault that lives only on your computer."],
  ["Does it use my Margin Chat credit?", "The AI runs on your own Claude, ChatGPT, Gemini or Muse subscription. Searching by meaning costs a tiny amount on your own OpenAI key or your Plus credit, the same as searching in the app."],
  ["How do I disconnect an app?", <>Open <strong>Profile → Agents</strong> and choose <strong>Revoke</strong> next to its token or signed-in app.</>],
];

export default function ConnectAppsPage({ webAppPath, signedIn, go }: ConnectAppsPageProps) {
  return (
    <>
      <section className="mk-page-head">
        <div className="mk-wrap">
          <p className="mk-eyebrow is-violet">MCP SERVER</p>
          <h1 className="mk-h1 is-page">Connect your AI apps</h1>
          <p className="mk-lede">Make Margin Chat the second brain for Claude, ChatGPT, Gemini, Muse and your coding agents. They search your notes while you chat and save what you make together, on the subscriptions you already pay for.</p>
        </div>
      </section>

      <section>
        <div className="mk-wrap">
          <picture>
            <source media="(max-width: 640px)" srcSet="/connect/ai-apps-to-margin-chat-narrow.svg" width={480} height={1220} />
            <img
              className="mk-connect-diagram"
              src="/connect/ai-apps-to-margin-chat.svg"
              width={1200}
              height={660}
              alt="Your AI apps connect to Margin Chat's MCP server at www.marginchat.com/api/mcp, by signing in or with a token from Profile, Agents. The server searches and reads your vault, and can create documents or add to them, but never edits or deletes."
            />
          </picture>
        </div>
      </section>

      <section className="mk-section is-short">
        <div className="mk-wrap mk-wrap-read">
          <h2 className="mk-h2">The server address</h2>
          <p className="mk-body">Every app below uses this one address. Copy it exactly, with <code>www.</code>.</p>
          <CopyCode code={MCP_SERVER_URL} label="Margin Chat MCP server address" />
          <nav className="mk-connect-jump" aria-label="Setup guides">
            <a href="#token">Make a token</a>
            {GUIDES.map((guide) => <a key={guide.id} href={`#${guide.id}`}>{guide.name}</a>)}
          </nav>
        </div>
      </section>

      <section className="mk-section is-short" id="token">
        <div className="mk-wrap mk-wrap-read">
          <p className="mk-eyebrow is-coral">STEP 1</p>
          <h2 className="mk-h2">Make a token in Margin Chat</h2>
          <p className="mk-body">Apps you set up with a command or a config file need a token. Claude apps, ChatGPT and Gemini sign in instead, so you can skip this for them.</p>
          <ol className="mk-connect-steps">
            <li>Open <a href={webAppPath} onClick={go}>{signedIn ? "Margin Chat" : "Margin Chat and sign in"}</a>. Choose the profile button at the bottom of the left panel, then the <strong>Agents</strong> tab.</li>
            <li>Name the token after the app it’s for, like “Claude Code”. Documents it saves are labelled with that name.</li>
            <li>Tick <strong>Can create documents and add to them</strong> if the app should save to your vault. Leave it off for search and read only.</li>
            <li>Choose <strong>Make token</strong> and copy it. It’s shown only once and works for up to a year, until you revoke it.</li>
          </ol>
          <p className="mk-connect-note">Treat a token like a password: one per app, and never paste it into a chat message.</p>
        </div>
      </section>

      {GUIDES.map((guide, index) => (
        <section className="mk-section is-short" id={guide.id} key={guide.id}>
          <div className="mk-wrap mk-wrap-read">
            {index === 0 ? <p className="mk-eyebrow is-sage">STEP 2 · ADD MARGIN CHAT TO YOUR APP</p> : null}
            <h2 className="mk-h2">{guide.name}</h2>
            <dl className="mk-connect-facts">
              <div><dt>Connects with</dt><dd>{guide.how}</dd></div>
              <div><dt>Can save to your vault</dt><dd>{guide.saves}</dd></div>
            </dl>
            <p className="mk-body">{guide.intro}</p>
            {guide.steps.length > 1
              ? <ol className="mk-connect-steps">{guide.steps.map((step, stepIndex) => <li key={stepIndex}>{step}</li>)}</ol>
              : guide.steps[0]}
            {guide.after ? <p className="mk-body">{guide.after}</p> : null}
          </div>
        </section>
      ))}

      <section className="mk-section is-short">
        <div className="mk-wrap mk-wrap-read">
          <h2 className="mk-h2">Other apps</h2>
          <p className="mk-body">Any app that supports remote MCP servers over Streamable HTTP can connect. If it offers sign-in (OAuth), give it the address and approve it in Margin Chat. Otherwise give it the address and the header <code>Authorization: Bearer {TOKEN}</code>.</p>
        </div>
      </section>

      <section className="mk-section is-short">
        <div className="mk-wrap mk-wrap-read">
          <p className="mk-eyebrow is-violet">STEP 3</p>
          <h2 className="mk-h2">Just ask</h2>
          <p className="mk-body">The AI decides when to use Margin Chat, or you can tell it to. Try:</p>
          <ul className="mk-connect-prompts">{PROMPTS.map((prompt) => <li key={prompt}>“{prompt}”</li>)}</ul>
        </div>
      </section>

      <section className="mk-section is-short is-last">
        <div className="mk-wrap mk-wrap-read">
          <h2 className="mk-h2">Questions</h2>
          <dl className="mk-faq">
            {FAQ.map(([question, answer]) => <div key={question}><dt>{question}</dt><dd>{answer}</dd></div>)}
          </dl>
          <p className="mk-body mk-connect-more">Building your own client? The <a href={`${REPO}/docs/mcp-server.md`}>MCP server reference</a> covers the tools, the protocol and sign-in.</p>
        </div>
      </section>
    </>
  );
}
