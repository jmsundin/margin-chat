import type { MouseEvent, ReactNode } from "react";
import { AUTH_PATHS, MARKETING_PATHS, SUPPORT_EMAIL } from "../../lib/siteRoutes";

// Update this date whenever either page's text changes.
export const LEGAL_UPDATED = "October 25, 2026";
const OPERATOR = "Sundin Systems LLC";

interface LegalPageProps {
  page: "terms" | "privacy";
  go: (event: MouseEvent<HTMLAnchorElement>) => void;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mk-legal-section">
      <h2 className="mk-h3">{title}</h2>
      {children}
    </section>
  );
}

function Support() {
  return <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>;
}

export default function LegalPage({ page, go }: LegalPageProps) {
  return (
    <>
      <section className="mk-page-head">
        <div className="mk-wrap">
          <h1 className="mk-h1 is-page">{page === "terms" ? "Terms of Service" : "Privacy Policy"}</h1>
          <p className="mk-lede">Last updated {LEGAL_UPDATED}. Questions go to <Support />.</p>
        </div>
      </section>
      <section>
        <div className="mk-wrap mk-wrap-read mk-legal">
          {page === "terms" ? <Terms go={go} /> : <Privacy go={go} />}
        </div>
      </section>
    </>
  );
}

function Terms({ go }: Pick<LegalPageProps, "go">) {
  return (
    <>
      <p className="mk-body">These terms are an agreement between you and {OPERATOR} ("we"), which runs Margin Chat at marginchat.com, the desktop app and the browser extension. By creating an account or using Margin Chat you accept them. Our <a href={MARKETING_PATHS.privacy} onClick={go}>Privacy Policy</a> explains what we do with your data.</p>

      <Section title="Your account">
        <ul className="mk-list">
          <li>You must be at least 16 years old to create an account.</li>
          <li>Give a real email address you can receive mail at. It is how you reset your password and how we reach you about your account.</li>
          <li>Keep your password and agent tokens private. You are responsible for what happens under your account.</li>
          <li>One person per account. Don't create accounts in bulk or by script.</li>
        </ul>
      </Section>

      <Section title="Your content">
        <p className="mk-body">Everything you write, upload or import stays yours. You give us only the permission we need to store it, sync it between your devices, index it for search, and send it to the AI provider you choose when you ask an AI feature to read it. We don't sell your content and don't use it to train AI models.</p>
        <p className="mk-body">Public maps and answers to public-map questions are visible to other members. Don't put anything private there.</p>
      </Section>

      <Section title="Acceptable use">
        <p className="mk-body">Don't use Margin Chat to break the law, to store or share material that exploits children, to harass anyone, to infringe someone else's copyright, to spread malware, or to attack, overload or probe the service. Don't try to get around usage limits, billing or another member's privacy. We may suspend an account that does these things, and we'll tell you why unless the law stops us.</p>
      </Section>

      <Section title="AI features">
        <p className="mk-body">AI answers come from third-party models and can be wrong, incomplete or out of date. Check anything that matters, and don't rely on Margin Chat for medical, legal or financial decisions. When you use your own API key, that provider's terms also apply to you.</p>
      </Section>

      <Section title="Plans, payment and refunds">
        <ul className="mk-list">
          <li>Prices are on the <a href={MARKETING_PATHS.pricing} onClick={go}>pricing page</a>. Stripe processes payments; we never see your full card number.</li>
          <li>Subscriptions renew every month until you cancel. Cancel anytime in Billing; you keep the plan until the end of the period you paid for.</li>
          <li>Hosted AI credit from Plus and from top-ups is prepaid. It is used up as you make AI requests, at the per-model prices shown in the app, and it has no cash value.</li>
          <li>If you're unhappy, email <Support /> within 14 days of a charge and we'll refund it. A refund removes the credit it bought.</li>
        </ul>
      </Section>

      <Section title="Storage limits">
        <p className="mk-body">Each paid plan includes the cloud storage shown in Settings. When your vault is full, new uploads stop until you delete files or we raise the limit; nothing you've already saved is removed.</p>
      </Section>

      <Section title="Ending your account">
        <p className="mk-body">You can delete your account at any time from Settings, Account, Delete account. Export your vault first if you want to keep a copy. We may close an account that breaks these terms or that has been inactive and unpaid for over two years, after emailing you at least 30 days ahead.</p>
      </Section>

      <Section title="The service is provided as is">
        <p className="mk-body">We work hard to keep Margin Chat running and your data safe, but we can't promise it will always be available or free of errors. Keep your own copy of anything you can't afford to lose. To the extent the law allows, we disclaim implied warranties, and our total liability for any claim is limited to the amount you paid us in the 12 months before it. We aren't liable for indirect or consequential losses.</p>
      </Section>

      <Section title="Changes">
        <p className="mk-body">If we change these terms in a way that matters, we'll email you or show a notice in the app at least 14 days before the change takes effect. Using Margin Chat after that means you accept the new terms.</p>
      </Section>

      <Section title="Contact">
        <p className="mk-body">Email <Support />. If you don't have an account yet, you can <a href={AUTH_PATHS.signup} onClick={go}>sign up here</a>.</p>
      </Section>
    </>
  );
}

function Privacy({ go }: Pick<LegalPageProps, "go">) {
  return (
    <>
      <p className="mk-body">{OPERATOR} runs Margin Chat. This page explains what we collect, why, who else handles it, and how to get it deleted. The short version: your notes are yours, we don't sell data, we don't use your content to train AI, and you can delete everything from Settings.</p>

      <Section title="What we collect">
        <ul className="mk-list">
          <li><strong>Account:</strong> your name, email address and a scrambled (hashed) form of your password. We never store the password itself.</li>
          <li><strong>Your content:</strong> documents, notes, uploaded files, chats and maps. On the free plan they stay in your browser or a folder you choose; on Cloud and Plus they are also stored on our servers so they sync.</li>
          <li><strong>Search index:</strong> passages and meaning vectors made from your cloud documents so search works.</li>
          <li><strong>Billing:</strong> your plan, credit balance and a record of AI usage and charges. Stripe holds your card details.</li>
          <li><strong>Technical:</strong> sign-in sessions, IP address for rate limiting and abuse prevention, and error reports when something breaks (browser, page and error, never your document text on purpose).</li>
        </ul>
        <p className="mk-body">We don't use advertising trackers or sell personal information.</p>
      </Section>

      <Section title="What AI providers see">
        <p className="mk-body">When you ask an AI feature something, we send the question and the parts of your vault it needs to the model you picked: OpenAI, Anthropic, Google, xAI, Meta or Hugging Face. Web search sends your query to Tavily, and voice typing sends your audio to OpenAI. With your own API key the request goes to that provider under your account. These providers don't train on data sent through their APIs under their business terms.</p>
        <p className="mk-body">Anything you mark <strong>Hide from AI</strong> is never sent to an AI provider or exposed to connected AI apps.</p>
        <p className="mk-body">The guest trial at /try uses the model built into Chrome; nothing leaves your computer.</p>
      </Section>

      <Section title="Who stores data for us">
        <ul className="mk-list">
          <li>Vercel hosts the app and stores cloud vault files (United States).</li>
          <li>Neon hosts the database with accounts, billing and the search index (United States).</li>
          <li>Stripe handles payments. Resend sends account emails such as password resets. Sentry receives error reports.</li>
          <li>Encrypted backups are kept with Cloudflare.</li>
        </ul>
      </Section>

      <Section title="How long we keep it">
        <ul className="mk-list">
          <li>Your content and account stay until you delete them.</li>
          <li>Deleted documents sit in Recently deleted for 30 days so you can restore them.</li>
          <li>When you delete your account, we remove your account, cloud files, search index and sessions right away. Older copies can remain in our encrypted backups until those backups are removed; we use backups only to recover from a failure and never to bring a deleted account back. Stripe keeps invoices as tax law requires.</li>
        </ul>
      </Section>

      <Section title="Your choices and rights">
        <ul className="mk-list">
          <li>Export your whole vault as Markdown files from the vault panel at any time.</li>
          <li>Change your name and email in Settings, Account.</li>
          <li>Delete your account in Settings, Account, Delete account.</li>
          <li>Ask us for a copy of your data, a correction, or anything else about your privacy at <Support />. We answer within 30 days. Depending on where you live (for example the EU, UK or California) you have legal rights to these, and you can complain to your local data protection authority.</li>
        </ul>
      </Section>

      <Section title="Security">
        <p className="mk-body">Connections use HTTPS. Cloud files are private and only reachable through your signed-in account. Personal API keys are encrypted. No system is perfectly secure; if we learn of a breach that affects you, we'll tell you promptly.</p>
      </Section>

      <Section title="Children">
        <p className="mk-body">Margin Chat is not for children under 16, and we don't knowingly collect their data. If you think a child has an account, email us and we'll delete it.</p>
      </Section>

      <Section title="Changes">
        <p className="mk-body">We'll email you or show a notice in the app before a change that matters takes effect. The date at the top shows the latest version. See also the <a href={MARKETING_PATHS.terms} onClick={go}>Terms of Service</a>.</p>
      </Section>
    </>
  );
}
