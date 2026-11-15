import { LEARNING_LANGUAGES, languageName, type LanguagePair } from "../lib/languageLearning";
import "./LanguageLookup.css";

/** The bar under the view menu in Language learning mode: which language is learned, and which one meanings come in. */
export function LanguageLearningBar({ pair, onChange }: { pair: LanguagePair; onChange: (pair: LanguagePair) => void }) {
  const options = (selected: string) => {
    const list = LEARNING_LANGUAGES.some((language) => language.code === selected) ? LEARNING_LANGUAGES : [...LEARNING_LANGUAGES, { code: selected, name: languageName(selected) }];
    return list.map((language) => <option key={language.code} value={language.code}>{language.name}</option>);
  };
  return <div className="language-learning-bar" role="group" aria-label="Language learning">
    <label>Learning <select value={pair.target} aria-label="Language you're learning"
      onChange={(event) => { const target = event.target.value; onChange({ target, base: target === pair.base ? pair.target : pair.base }); }}>{options(pair.target)}</select></label>
    <span aria-hidden="true" className="language-learning-arrow">→</span>
    <label>meanings in <select value={pair.base} aria-label="Language meanings are shown in"
      onChange={(event) => { const base = event.target.value; onChange({ base, target: base === pair.target ? pair.base : pair.target }); }}>{options(pair.base)}</select></label>
    <span className="language-learning-hint">Tap a word, or drag across a few, to see and save what it means. ← → walk the words you’re learning.</span>
  </div>;
}
