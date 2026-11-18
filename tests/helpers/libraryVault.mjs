/**
 * A large synthetic vault for testing the Map and Explore at scale: themes > topics > blocks >
 * notes, in folders, with wiki links inside a block, across a topic and now and then across
 * themes. Titles are made up from a fixed taxonomy, so every run makes the same vault.
 * Not real user data. Used by scripts/test-vault-preview.mjs ({ action: "library", count }).
 */

// Each topic line: "Topic|Block: item, item, item|Block: item, item, item|…".
const TAXONOMY = {
  "Biology of aging": [
    "Cellular senescence|Senolytic drugs: Dasatinib and quercetin, Fisetin, Navitoclax|SASP and inflammation: IL-6, NF-κB, Inflammaging|Senescence markers: p16INK4a, SA-β-gal, Lamin B1|Immune clearance: NK cells, Senescent T cells, CAR-T senolytics",
    "Mitochondria|NAD+: NMN, Nicotinamide riboside, CD38|Mitophagy: Urolithin A, PINK1, Parkin|Oxidative stress: Free radicals, Mitohormesis, Glutathione|Biogenesis: PGC-1α, Exercise and mitochondria, Cold exposure",
    "Epigenetics|Reprogramming: Yamanaka factors, OSK, Chemical cocktails|Information loss: ICE mouse, Methylation drift, Chromatin|Histones: Sirtuins, HDAC inhibitors, Histone marks|Transposons: LINE-1, Retrotransposons, Reverse transcriptase inhibitors",
    "Proteostasis|Autophagy: Spermidine, Fasting autophagy, mTOR and autophagy|Aggregates: Amyloid, Tau, Alpha-synuclein|Chaperones: Heat shock proteins, Sauna, HSF1|Proteasome: Ubiquitin, Proteasome activators, Protein turnover",
    "Stem cells|Stem cell exhaustion: Hematopoietic stem cells, Muscle satellite cells, Clonal hematopoiesis|Regeneration: Axolotl, Planaria, Parabiosis|Young blood: GDF11, Plasma exchange, TIMP2|Organoids: Brain organoids, Gut organoids, Lab-grown organs",
    "Model organisms|Mice: ITP mice, Naked mole rat, Klotho mice|Worms and flies: C. elegans, Daf-2, Drosophila|Long-lived species: Bowhead whale, Greenland shark, Hydra|Dogs: Dog Aging Project, Rapamycin in dogs, Big dogs die young",
  ],
  "Medicine and drugs": [
    "Longevity drugs|Rapamycin: Rapamycin dosing, Everolimus, Rapalogs|Metformin: TAME trial, Metformin and exercise, Acarbose|GLP-1 drugs: Semaglutide, Tirzepatide, Retatrutide|SGLT2 inhibitors: Canagliflozin, Empagliflozin, Kidney protection",
    "Supplements|Well supported: Creatine, Omega-3, Vitamin D|Speculative: Alpha-ketoglutarate, GlyNAC, Lithium microdose|Faded: Resveratrol, Antioxidant pills, Growth hormone|Minerals: Magnesium, Zinc, Iron overload",
    "Heart and vessels|Cholesterol: ApoB, Statins, PCSK9 inhibitors|Blood pressure: Hypertension, Salt, Home cuff readings|Plaque: CAC score, CT angiography, Plaque regression|Rhythm: Atrial fibrillation, Wearable ECG, Ablation",
    "Cancer|Screening: Colonoscopy, Low-dose CT, Multi-cancer blood tests|Immunotherapy: Checkpoint inhibitors, CAR-T, Cancer vaccines|Prevention: HPV vaccine, Aspirin and cancer, Alcohol and cancer|Biology: Oncogenes, Tumour suppressors, Metastasis",
    "Brain health|Dementia: Alzheimer's disease, Lecanemab, APOE4|Stroke: Stroke signs, Thrombectomy, Silent strokes|Cognition: Cognitive reserve, Hearing loss and dementia, Brain training|Neurodegeneration: Parkinson's disease, ALS, Huntington's disease",
    "Clinical trials|Trials to watch: PEARL trial, XPRIZE Healthspan, TRIAD|Trial design: Surrogate endpoints, Randomisation, Placebo effects|Regulation: FDA and aging, Orphan drugs, Accelerated approval|Reading papers: Hazard ratios, P-hacking, Meta-analyses",
  ],
  "Measuring health": [
    "Aging clocks|Methylation clocks: Horvath clock, GrimAge, DunedinPACE|Organ clocks: Proteomic clocks, Heart age, Brain age|Other clocks: GlycanAge, Telomere length, Facial age|Clock problems: Clock reliability, Test-retest noise, What clocks miss",
    "Blood labs|Metabolic: HbA1c, Fasting insulin, Triglycerides|Inflammation: hs-CRP, Ferritin, White cell count|Kidney and liver: Cystatin C, ALT, eGFR|Hormones: Testosterone, Thyroid, Cortisol",
    "Fitness markers|Aerobic: VO2 max, Resting heart rate, Heart rate variability|Strength: Grip strength, Leg press, Chair stands|Balance: One-leg stand, Gait speed, Falls|Body: DEXA, Visceral fat, Waist to height",
    "Imaging|Scans: Full-body MRI, CT, Ultrasound|Bones: Bone density, Osteoporosis, Fracture risk|Eyes: Retinal age, OCT scans, Glaucoma|Skin: Skin checks, Melanoma, Mole mapping",
    "Self-tracking|Wearables: Oura ring, Whoop, Apple Watch|Glucose: CGM experiments, Glucose spikes, Fibre and glucose|Logs: Quarterly lab log, Blood pressure log, Weight log|Experiments: n-of-1 trials, Washout periods, Tracking fatigue",
  ],
  "Lifestyle and fitness": [
    "Exercise|Cardio: Zone 2, Norwegian 4x4, Rucking|Strength: Strength over 40, Deadlifts, Progressive overload|Mobility: Stretching, Yoga, Hip mobility|Recovery: Deload weeks, Soreness, Overtraining",
    "Nutrition|Fasting: Time-restricted eating, Prolonged fasting, Fasting-mimicking diet|Diet patterns: Mediterranean diet, Blue zones, Keto|Protein: Protein targets, Leucine, Plant protein|Foods: Olive oil, Fermented foods, Ultra-processed food",
    "Sleep|Sleep science: Glymphatic clearance, REM sleep, Deep sleep|Sleep problems: Sleep apnea, Insomnia, Restless legs|Sleep habits: Evening light, Caffeine timing, Bedroom temperature|Sleep tools: Magnesium for sleep, Melatonin, Sleep trackers",
    "Stress and mind|Stress: Cortisol, Burnout, Stress and telomeres|Meditation: Mindfulness, Breathwork, Meditation studies|Social: Loneliness, Friendship, Purpose|Habits: Habit stacking, Willpower, Environment design",
    "Environment|Air: Air quality, PM2.5, Indoor plants|Heat and cold: Sauna, Cold plunge, Heat waves|Toxins: Microplastics, Lead, PFAS|Light: Sunlight, Blue light, Circadian rhythm",
  ],
  "Neuroscience": [
    "Neurons|Signalling: Action potentials, Synapses, Neurotransmitters|Plasticity: LTP, Neurogenesis, Critical periods|Glia: Astrocytes, Microglia, Myelin|Brain areas: Hippocampus, Prefrontal cortex, Cerebellum",
    "Memory|Kinds of memory: Working memory, Episodic memory, Procedural memory|Learning: Spaced repetition, Retrieval practice, Interleaving|Forgetting: Forgetting curve, Interference, Sleep and memory|Memory tools: Memory palace, Flashcards, Note-taking",
    "Consciousness|Theories: Global workspace, Integrated information, Higher-order theories|States: Dreams, Anaesthesia, Flow|Perception: Attention, Illusions, Predictive processing|Self: Free will, Agency, Body ownership",
    "Mental health|Mood: Depression, Bipolar disorder, Seasonal mood|Anxiety: Panic, Generalised anxiety, Exposure therapy|Treatments: CBT, SSRIs, Psychedelic therapy|ADHD: ADHD in adults, Stimulants, Focus tricks",
  ],
  "Computer science": [
    "Programming languages|TypeScript: Type narrowing, Generics, Discriminated unions|Python: Python async, Pandas, Type hints|Java: Java streams, Spring Boot, JVM tuning|SQL: Joins, Window functions, Query plans",
    "Systems|Databases: Postgres indexes, Transactions, Replication|Networking: TCP, HTTP/3, DNS|Operating systems: Processes, Memory management, File systems|Distributed systems: Consensus, CAP theorem, Event sourcing",
    "Web development|Frontend: React hooks, CSS layout, Accessibility|Backend: REST APIs, Auth sessions, Rate limiting|Performance: Web vitals, Bundle size, Caching|Testing: Unit tests, End-to-end tests, Flaky tests",
    "Machine learning|Foundations: Gradient descent, Backpropagation, Overfitting|Language models: Transformers, Embeddings, Fine-tuning|Retrieval: Vector search, RAG, Rerankers|Agents: Tool use, Agent loops, Evals",
    "Algorithms|Data structures: Hash maps, Trees, Heaps|Graphs: Shortest paths, PageRank, Community detection|Search: Binary search, Tries, Fuzzy matching|Complexity: Big O, NP-hard problems, Amortised analysis",
    "Security|Web security: XSS, CSRF, SQL injection|Crypto: Hashing, Public keys, TLS|Identity: Passkeys, OAuth, Password storage|Operations: Secrets management, Backups, Incident response",
  ],
  "Building Margin Chat": [
    "Map and explore|Map views: Zoom ladder, Topic boxes, Map at millions|Explore: Library browsing, Clusters layout, Wikipedia source|Search: Vague recall search, Search speed, Search answers|Graph: Typed links, Bridges, Backlinks",
    "Editor|Writing: Margin notes, Side documents, Live preview|Studying: Flashcards design, Review queue, Quiz cards|Code: Code cells, Code suggestions, Phone code keys|Pages: HTML pages, Play mode, Game saves",
    "Launch|Payments: Stripe webhooks, Pricing tiers, Refunds|Data safety: Off-site backups, Version history, Export|Marketing: Launch video, Obsidian comparison, Landing page|Support: Support mailbox, Help docs, Onboarding tour",
    "Desktop and phone|Desktop app: Electron builds, Vault folder sync, Mac signing|Phone: PWA startup, Phone keyboard bar, Bottom sheets|Sync: Cloud sync, Conflicts, Offline edits|Performance: Vault open speed, Large vaults, Memory use",
    "AI features|Ask AI: Ask from a note, Ask with the screen, Model picker|Roadmaps: Roadmap drafts, Learn view, Dive deeper|Language: Interactive reader, Lookup pane, Courses|Agents: Agent mode, Web search, Claim checking",
  ],
  "Finance and career": [
    "FINRA exams|Series 7: Options, Municipal bonds, Margin accounts|SIE: Market structure, Regulation basics, Investment risks|Series 63: State law, Agent registration, Ethics|Study plan: Practice exams, Weak spots, Exam day",
    "Investing|Index funds: Total market funds, Expense ratios, Rebalancing|Bonds: Treasuries, Duration, TIPS|Retirement: 401k, Roth IRA, Withdrawal rates|Behaviour: Loss aversion, Market timing, Panic selling",
    "Mortgages and housing|Mortgage markets: MBS, Prepayment risk, Agency guarantees|Buying a home: Down payments, Rate locks, Closing costs|Housing data: Home price indexes, Inventory, Affordability|Credit: Credit scores, Debt to income, Underwriting",
    "Career|Engineering career: Promotions, Staff engineer, Code review culture|Interviews: System design interviews, Coding interviews, Behavioural interviews|Side projects: Shipping fast, Choosing a niche, Burnout on side projects|Learning: Courses, Mentors, Reading lists",
    "Business|Startups: Product-market fit, Fundraising, Bootstrapping|Pricing: Freemium, Usage pricing, Annual plans|Growth: SEO, Word of mouth, Communities|Operations: Taxes for founders, LLC setup, Bookkeeping",
  ],
  "Mathematics": [
    "Calculus|Limits: Epsilon-delta, Continuity, L'Hôpital|Derivatives: Chain rule, Optimisation, Related rates|Integrals: Integration by parts, Fundamental theorem, Improper integrals|Series: Taylor series, Convergence tests, Power series",
    "Linear algebra|Vectors: Dot product, Cross product, Vector spaces|Matrices: Matrix multiplication, Determinants, Inverses|Eigen: Eigenvalues, Diagonalisation, Spectral theorem|Applications: SVD, PCA, Least squares",
    "Probability and statistics|Probability: Bayes' theorem, Conditional probability, Random variables|Distributions: Normal distribution, Poisson, Power laws|Inference: Confidence intervals, Hypothesis tests, Bayesian inference|Causality: Confounders, Randomised trials, Instrumental variables",
    "Discrete maths|Logic: Proofs, Induction, Set theory|Combinatorics: Permutations, Pigeonhole, Generating functions|Number theory: Primes, Modular arithmetic, RSA maths|Graph theory: Euler paths, Colouring, Trees",
  ],
  "Physics and chemistry": [
    "Classical physics|Mechanics: Newton's laws, Energy, Momentum|Waves: Sound, Interference, Resonance|Thermodynamics: Entropy, Heat engines, Second law|Electromagnetism: Maxwell's equations, Circuits, Light",
    "Modern physics|Quantum: Wave functions, Entanglement, Uncertainty|Relativity: Special relativity, General relativity, Gravitational waves|Particles: Standard model, Higgs boson, Neutrinos|Cosmology: Big Bang, Dark matter, Dark energy",
    "Chemistry|Atoms: Periodic table, Electron shells, Bonds|Reactions: Equilibrium, Kinetics, Catalysts|Organic: Functional groups, Polymers, Chirality|Biochemistry: Enzymes, ATP, Metabolism",
    "Earth and space|Climate: Greenhouse effect, Carbon cycle, Climate models|Geology: Plate tectonics, Volcanoes, Earthquakes|Planets: Mars, Exoplanets, Jupiter's moons|Space flight: Rockets, Orbits, Space stations",
  ],
  "History": [
    "Ancient world|Egypt: Pyramids, Pharaohs, Hieroglyphs|Greece: Athens, Sparta, Greek philosophy|Rome: Roman Republic, Roman Empire, Fall of Rome|China: Han dynasty, Great Wall, Silk Road",
    "Medieval and early modern|Middle Ages: Feudalism, Black Death, Crusades|Renaissance: Florence, Printing press, Leonardo|Exploration: Columbus, Magellan, Spice trade|Reformation: Luther, Wars of religion, Counter-Reformation",
    "Modern history|Revolutions: American Revolution, French Revolution, Industrial Revolution|World wars: World War I, World War II, Cold War|Empires: British Empire, Decolonisation, Ottoman Empire|20th century: Civil rights, Space race, Fall of the Berlin Wall",
    "History of science|Medicine history: Germ theory, Penicillin, Vaccines history|Scientific revolution: Copernicus, Galileo, Newton|Computing history: Turing, ENIAC, The internet|Biology history: Darwin, DNA discovery, Human Genome Project",
  ],
  "Languages": [
    "Spanish|Grammar: Ser and estar, Subjunctive, Preterite and imperfect|Vocabulary: Food words, Travel phrases, False friends|Listening: Podcasts in Spanish, Spanish TV, Accents|Reading: Graded readers, News in Spanish, Short stories",
    "German|Grammar: Cases, Word order, Separable verbs|Vocabulary: Compound words, Everyday German, Gender of nouns|Listening: German podcasts, Dialects, Slow German|Reading: German stories, Newspapers, Children's books",
    "Learning methods|Input: Comprehensible input, Extensive reading, Shadowing|Output: Speaking practice, Writing journals, Language exchange|Tools: Anki decks, LingQ, Dictionaries|Motivation: Daily streaks, Plateaus, Immersion trips",
    "Linguistics|Sounds: Phonetics, IPA, Minimal pairs|Structure: Morphology, Syntax, Semantics|Families: Indo-European, Romance languages, Germanic languages|Change: Sound shifts, Loanwords, Language death",
  ],
  "Sports": [
    "Football|Women's football: Women's World Cup, NWSL, Women's Champions League|Men's football: Premier League, Champions League, World Cup|Tactics: Pressing, Formations, Set pieces|Players: Goalkeepers, Strikers, Midfielders",
    "Running and endurance|Marathon: Marathon training, Fuelling, Taper|Trail running: Ultra races, Hill training, Trail shoes|Cycling: Tour de France, Power meters, Bike fit|Swimming: Freestyle technique, Open water, Swim drills",
    "Strength sports|Powerlifting: Squat, Bench press, Deadlift meets|Weightlifting: Snatch, Clean and jerk, Olympic lifting|Climbing: Bouldering, Finger strength, Lead climbing|Martial arts: Jiu-jitsu, Boxing, Judo",
    "Team sports|Basketball: NBA, WNBA, Three-point era|Baseball: Sabermetrics, Pitching, World Series|American football: NFL, Concussions, Quarterbacks|Tennis: Grand slams, Serve technique, Tennis elbow",
  ],
  "Arts and culture": [
    "Books|Novels: Classic novels, Science fiction, Literary fiction|Non-fiction: Popular science, Biographies, History books|Reading habits: Reading lists, Book notes, Reading speed|Writing: Essay craft, Storytelling, Editing",
    "Music|Theory: Scales, Chords, Rhythm|Instruments: Guitar practice, Piano practice, Singing|Genres: Jazz, Classical music, Hip hop|Listening: Albums to hear, Concerts, Music and memory",
    "Film and TV|Films: Film directors, Documentaries, Animation|Series: Prestige TV, Sitcoms, Miniseries|Craft: Cinematography, Screenwriting, Editing film|Watch lists: Films to watch, Series to watch, Rewatches",
    "Visual arts|Painting: Impressionism, Abstract art, Portraits|Design: Typography, Colour theory, Grid systems|Photography: Composition, Street photography, Film cameras|Architecture: Modernism, Gothic cathedrals, Housing design",
  ],
  "Philosophy and religion": [
    "Ethics|Theories: Utilitarianism, Kantian ethics, Virtue ethics|Applied: Bioethics, AI ethics, Animal ethics|Death: Ethics of life extension, Mortality, Meaning of death|Everyday: Honesty, Generosity, Fairness",
    "Mind and knowledge|Epistemology: Knowledge, Scepticism, Bayesian belief|Philosophy of mind: Dualism, Physicalism, Personal identity|Science: Falsifiability, Paradigms, Induction problem|Language: Meaning, Reference, Wittgenstein",
    "Schools|Stoicism: Marcus Aurelius, Seneca, Epictetus|Existentialism: Camus, Sartre, Kierkegaard|Eastern philosophy: Buddhism, Taoism, Confucianism|Analytic philosophy: Russell, Quine, Rawls",
    "Religion|World religions: Christianity, Islam, Hinduism|Practices: Prayer, Fasting traditions, Pilgrimage|Secular life: Secular humanism, Meaning without religion, Rituals|History of religion: Early church, Reformation movements, Religious texts",
  ],
  "Personal": [
    "Home|Cooking: Weeknight dinners, Batch cooking, Recipes to try|Home projects: Garden, Repairs, Decluttering|Money at home: Budget, Bills, Subscriptions|Family: Birthdays, Family visits, Gift ideas",
    "Travel|Trips: Spain trip, Germany trip, Japan trip|Planning: Packing lists, Flights, Where to stay|Places: Cities to visit, National parks, Hikes|Memories: Trip journals, Photos to sort, Travel lessons",
    "Journal|Daily notes: Morning pages, Evening review, Gratitude|Reviews: Weekly review, Monthly review, Year review|Goals: 2026 goals, Long-term goals, Not-to-do list|Ideas: Ideas inbox, Questions to explore, Someday maybe",
  ],
};

const ASPECTS = ["overview", "key studies", "open questions", "beginner guide", "my notes", "reading list", "common mistakes", "history", "how it works",
  "evidence review", "practical protocol", "debates", "glossary", "timeline", "people to follow", "papers to read", "examples", "summary",
  "worked problems", "checklist", "what changed in 2026", "comparison", "myths", "deep dive", "first principles", "lessons learned", "FAQ", "case study"];

const slug = (value) => value.replace(/[\\/:*?"<>|#^[\]]/gu, "").replace(/\s+/gu, " ").trim();

/** The taxonomy as nested groups, and every note it makes, `count` in all. */
export function buildLibraryVault(count = 10000) {
  const blocks = [];
  for (const [theme, topics] of Object.entries(TAXONOMY)) {
    for (const line of topics) {
      const [topic, ...rest] = line.split("|");
      for (const part of rest) {
        const [block, items] = part.split(":");
        blocks.push({ theme, topic, block: block.trim(), items: items.split(",").map((item) => item.trim()) });
      }
    }
  }
  // Blocks get unequal sizes, as real vaults do: some subjects you write about a lot.
  const weights = blocks.map((_, index) => 0.4 + ((index * 7919) % 97) / 40);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const sizes = weights.map((weight) => Math.max(2, Math.round((weight / total) * count)));
  let difference = count - sizes.reduce((sum, size) => sum + size, 0);
  for (let index = 0; difference !== 0; index = (index + 1) % sizes.length) {
    if (difference > 0) { sizes[index]++; difference--; } else if (sizes[index] > 2) { sizes[index]--; difference++; }
  }
  const notes = [];
  const used = new Set();
  blocks.forEach((block, blockIndex) => {
    for (let at = 0; at < sizes[blockIndex]; at++) {
      const item = block.items[at % block.items.length];
      const aspect = ASPECTS[Math.floor(at / block.items.length) % ASPECTS.length];
      const round = Math.floor(at / (block.items.length * ASPECTS.length));
      let title = slug(round ? `${item}: ${aspect} ${round + 1}` : `${item}: ${aspect}`);
      if (used.has(title.toLowerCase())) title = slug(`${title} (${block.block})`);
      if (used.has(title.toLowerCase())) title = slug(`${title} ${notes.length}`);
      used.add(title.toLowerCase());
      // Most notes sit in theme/topic folders; some are loose in an inbox, as in a real vault.
      const folder = notes.length % 11 === 0 ? "Inbox" : `${slug(block.theme)}/${slug(block.topic)}`;
      notes.push({ path: `${folder}/${title}.md`, title, theme: block.theme, topic: block.topic, block: block.block, item, aspect, blockIndex });
    }
  });
  // Links: the next note in the block, another note on the same item, and now and then one in
  // another topic or theme, so the map has bridges as well as clumps.
  const byBlock = new Map();
  for (const note of notes) byBlock.set(note.blockIndex, [...(byBlock.get(note.blockIndex) ?? []), note]);
  notes.forEach((note, index) => {
    const siblings = byBlock.get(note.blockIndex);
    const at = siblings.indexOf(note);
    const links = new Set();
    if (siblings.length > 1) links.add(siblings[(at + 1) % siblings.length].title);
    const sameItem = siblings.find((other) => other !== note && other.item === note.item && !links.has(other.title));
    if (sameItem && index % 2 === 0) links.add(sameItem.title);
    if (index % 9 === 0) links.add(notes[(index * 131 + 17) % notes.length].title);
    if (index % 23 === 0) links.add(notes[(index * 977 + 401) % notes.length].title);
    links.delete(note.title);
    const related = [...links].map((title) => `[[${title}]]`).join(", ");
    note.content = `# ${note.title}\n\n${note.item}, ${note.aspect}. Notes on ${note.item.toLowerCase()} as part of ${note.block.toLowerCase()} in ${note.topic.toLowerCase()}, `
      + `under ${note.theme.toLowerCase()}. What I know so far, what the sources say, and what to read next.\n\n`
      + `- ${note.item} matters for ${note.block.toLowerCase()} because it comes up again and again in ${note.topic.toLowerCase()}.\n`
      + `- Open question: how does ${note.item.toLowerCase()} relate to the rest of ${note.theme.toLowerCase()}?\n\n`
      + (related ? `Related: ${related}\n` : "");
  });
  return notes;
}

const STOP = new Set(["the", "and", "for", "with", "what", "how", "notes", "note", "about", "know", "far", "sources", "say", "read", "next", "part", "under", "matters",
  "because", "comes", "again", "rest", "open", "question", "does", "relate", "related", "this", "that", "from", "into", "are", "its", "far", "so"]);
// The kind of note (overview, reading list…) says little about its subject, as with a real embedding model.
for (const aspect of ASPECTS) for (const word of aspect.toLowerCase().split(/\s+/u)) STOP.add(word);

/**
 * A made-up meaning vector for a note's text: each word lands on two of 512 dimensions, so notes
 * that share words point the same way. Stands in for an embedding model in tests only.
 */
export function fixtureEmbedding(text, dimensions = 512) {
  const values = new Float64Array(dimensions);
  const words = String(text).toLowerCase().normalize("NFKD").replace(/\[\[[^\]]*\]\]/gu, " ").match(/\p{L}[\p{L}\p{N}'-]{2,}/gu) ?? [];
  for (const word of words) {
    if (STOP.has(word)) continue;
    let hash = 2166136261;
    for (let index = 0; index < word.length; index++) hash = Math.imul(hash ^ word.charCodeAt(index), 16777619) >>> 0;
    values[hash % dimensions] += 1;
    values[(hash >>> 9) % dimensions] += (hash & 1) ? 0.5 : -0.5;
  }
  let length = 0;
  for (const value of values) length += value * value;
  length = Math.sqrt(length) || 1;
  return Array.from(values, (value) => value / length);
}
