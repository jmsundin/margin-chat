/** A window split in two, the right half a pane: the same "open to the side" sign Notion and VS Code use. */
export default function OpenBesideIcon({ size = 16 }: { size?: number }) {
  return <svg className="open-beside-icon" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" fill="none"
    stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
    <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
    <path d="M9 2.75v10.5M11 6.25h1.25M11 8.75h1.25" />
  </svg>;
}
