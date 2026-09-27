export const overlayStyles = `
:host { all: initial; color-scheme: light; }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
.panel { position: fixed; z-index: 2147483647; top: 14px; right: 14px; bottom: 14px; width: 390px; max-width: calc(100vw - 28px); display: flex; flex-direction: column; overflow: hidden; color: #283e33; background: #faf8f1; border: 1px solid #cbd3c6; border-radius: 18px; box-shadow: 0 16px 70px #152b352b; font: 14px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; text-align: left; }
button, input, textarea { font: inherit; color: inherit; }
button { cursor: pointer; border: 1px solid #cdd4c8; border-radius: 9px; background: #fffdf8; padding: 9px 12px; line-height: 1.3; }
button:hover { background: #eaf0e5; }
button:disabled { opacity: .5; cursor: default; }
button:focus-visible, input:focus-visible, textarea:focus-visible, a:focus-visible { outline: 2px solid #527a4f; outline-offset: 3px; }
header { padding: 18px 20px 13px; display: flex; align-items: center; gap: 10px; }
.mark { width: 30px; height: 30px; display: grid; place-items: center; border-radius: 9px; background: #315b45; color: #faf8f1; font-family: Georgia, serif; font-size: 22px; }
.brand { flex: 1; font-size: 18px; font-weight: 650; letter-spacing: -.5px; }
.privacy { color: #667660; font-size: 11px; border: 1px solid #dce2d5; border-radius: 20px; padding: 3px 8px; }
.icon { border: 0; background: transparent; font-size: 21px; padding: 3px 8px; }
.page { margin: 0 20px 14px; padding-left: 11px; border-left: 2px solid #c4cfa9; }
.page strong { font: 500 15px/1.35 Georgia, serif; display: block; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.page small { display: block; color: #74806c; font-size: 11px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; margin-top: 4px; }
nav { display: flex; padding: 0 20px; gap: 18px; border-bottom: 1px solid #e0e4d8; }
nav button { border: 0; border-radius: 0; background: transparent; color: #75806b; padding: 10px 0 12px; font-size: 12px; }
nav button[aria-pressed=true] { border-bottom: 2px solid #416348; color: #2c513d; font-weight: 650; }
main { flex: 1; overflow: auto; padding: 20px; overscroll-behavior: contain; }
h1 { font: 500 26px/1.15 Georgia, serif; letter-spacing: -.6px; margin: 0 0 10px; }
h2 { font-size: 12px; font-weight: 600; margin: 22px 0 10px; }
p { margin: 8px 0; overflow-wrap: anywhere; }
.muted { font-size: 12px; color: #74806d; }
.eyebrow { text-transform: uppercase; font-size: 10px; letter-spacing: 1.5px; color: #868267; margin-bottom: 10px; }
.modes { display: flex; gap: 4px; background: #eeefe5; border-radius: 9px; padding: 3px; margin: 17px 0; }
.modes button { flex: 1; padding: 7px 5px; font-size: 11px; border: 0; background: transparent; }
.modes button[aria-pressed=true] { background: #fffdf8; box-shadow: 0 1px 4px #283e3314; }
label { font-size: 11px; font-weight: 600; display: block; margin: 14px 0 6px; }
input, textarea { width: 100%; background: #fffef9; border: 1px solid #d6ddce; border-radius: 9px; padding: 10px 12px; line-height: 1.5; }
input { font-size: 13px; }
textarea { font-size: 13px; resize: vertical; min-height: 95px; max-height: 270px; }
textarea[readonly] { background: #f0f1e7; font: 13px/1.7 Georgia, serif; min-height: 75px; max-height: 150px; }
.context-label { display: flex; justify-content: space-between; align-items: center; }
.context-label button { border: 0; padding: 0; font-size: 10px; background: transparent; color: #5b7654; }
.primary { background: #315b45; color: #fffdf8; border-color: #315b45; width: 100%; margin-top: 12px; padding: 11px; }
.primary:hover { background: #264a37; }
.suggestions { display: flex; flex-wrap: wrap; gap: 5px; margin: 10px 0; }
.suggestions button { padding: 6px 8px; border-radius: 15px; font-size: 10px; color: #667660; }
.status { margin: 0 20px; padding: 0 0 12px; font-size: 12px; white-space: pre-line; }
.status:empty { display: none; }
.error { color: #a34632; }
footer { border-top: 1px solid #e0e4d8; padding: 12px 20px; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
footer span { font-size: 10px; color: #7b866f; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
footer button { font-size: 11px; border: 0; background: none; padding: 4px 0; white-space: nowrap; }
.entry { border: 1px solid #dde2d4; background: #fffdf8; border-radius: 10px; padding: 12px; margin: 9px 0; }
.entry blockquote { margin: 0 0 8px; padding: 2px 0 2px 10px; border-left: 2px solid #ccd397; font: 13px/1.5 Georgia, serif; white-space: pre-wrap; overflow-wrap: anywhere; }
.entry p { font-size: 12px; white-space: pre-wrap; }
.entry .actions { display: flex; gap: 12px; margin-top: 9px; }
.entry button { border: 0; font-size: 10px; background: none; padding: 0; color: #527349; }
.entry small { font-size: 10px; color: #88907a; }
.pending { background: #f1efdf; padding: 12px; border-radius: 10px; margin-bottom: 16px; font-size: 12px; }
.pending button { margin: 8px 5px 0 0; font-size: 11px; }
.community { margin-top: 15px; }
.community .entry { background: transparent; }
.community h2 { margin-top: 0; }
.community p { font-size: 12px; }
.empty { border: 1px dashed #d2d9c7; border-radius: 10px; padding: 15px; color: #859078; font-size: 12px; }
.view-controls { display: flex; gap: 3px; align-items: center; margin: 0 20px 15px; padding: 3px; background: #eeefe5; border-radius: 8px; }
.view-controls button { border: 0; background: transparent; padding: 5px 7px; font-size: 10px; border-radius: 5px; }
.view-controls button[aria-pressed=true] { background: #fffdf8; box-shadow: 0 1px 4px #283e3314; }
.view-controls #peek { margin-left: auto; color: #527349; }
.panel[data-layout=floating] { bottom: auto; height: min(720px, calc(100vh - 28px)); min-height: 350px; min-width: min(320px, calc(100vw - 28px)); max-height: calc(100vh - 12px); resize: both; }
.panel[data-layout=floating] header { cursor: grab; touch-action: none; user-select: none; }
.panel[data-layout=expanded] { left: 68px; width: auto; max-width: none; }
.panel[data-layout=expanded] .capture-layout { display: grid; grid-template-columns: minmax(260px, 1fr) minmax(220px, .8fr); gap: 36px; max-width: 1100px; margin: 10px auto; }
.panel[data-layout=expanded] .history { border-left: 1px solid #e0e4d8; padding-left: 30px; }
.panel[data-layout=expanded] main { padding: 25px 35px; }
.panel[data-layout=expanded] textarea[readonly] { min-height: 170px; max-height: 300px; }
.panel.peeking { visibility: hidden; pointer-events: none; }
.peek-tab { position: fixed; z-index: 2147483647; right: 0; top: 30%; writing-mode: vertical-rl; padding: 17px 11px; background: #315b45; color: #fffdf8; border-radius: 10px 0 0 10px; font: 12px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; box-shadow: 0 5px 25px #152b352b; }
.page-reveal { position: fixed; z-index: 2147483647; left: 0; top: 40%; writing-mode: vertical-rl; padding: 16px 10px; background: #fffdf8e8; border-radius: 0 9px 9px 0; font: 12px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; box-shadow: 0 3px 20px #152b351a; }
@media (max-width: 800px) { .panel[data-layout=expanded] .capture-layout { display: block; } .panel[data-layout=expanded] .history { border-left: 0; padding-left: 0; } .panel[data-layout=expanded] main { padding: 20px; } }
@media (max-width: 480px) { .panel { top: 6px; right: 6px; bottom: 6px; width: calc(100vw - 12px); max-width: none; border-radius: 12px; } }
`;
