/**
 * Synthetic vault for the Map zoom-level fixture: sample longevity notes in themes, topics and
 * blocks, so made-up meaning vectors can stand in for the server's. Not real user data.
 */
export interface SampleGroup { name: string; hue?: number; summary?: string; groups?: SampleGroup[]; docs?: string[] }
export const SAMPLE_VAULT: SampleGroup = {name:"All notes", groups:[
 {name:"Biology of aging", hue:205, summary:"Why cells and tissues decline: damage, signalling, and the hallmarks you keep coming back to.", groups:[
   {name:"Cellular senescence", summary:"Zombie cells, the inflammation they send out, and drugs that clear them.", groups:[
     {name:"Senolytic drugs", docs:["Dasatinib + quercetin protocol","Fisetin dosing notes","Navitoclax and platelets","Why UBX0101 failed","Intermittent senolytic dosing"]},
     {name:"SASP and inflammation", docs:["SASP factors list","IL-6 and inflammaging","NF-κB in senescent cells","Senomorphics vs senolytics"]},
     {name:"Senescence markers", docs:["p16INK4a as a marker","SA-β-gal staining","Senescence in skin biopsies"]}]},
   {name:"Mitochondria", summary:"Energy decline with age, NAD+ precursors, and clearing out damaged mitochondria.", groups:[
     {name:"NAD+", docs:["NAD+ decline with age","NMN vs NR","CD38 eats NAD+","Niacin as a cheap precursor"]},
     {name:"Mitophagy", docs:["Urolithin A trials","PINK1 / Parkin pathway","Mitophagy and exercise"]},
     {name:"Oxidative stress", docs:["Free radical theory revisited","Mitohormesis"]}]},
   {name:"Epigenetics", summary:"Aging as lost cell identity, and whether partial reprogramming can restore it.", groups:[
     {name:"Reprogramming", docs:["Partial reprogramming with Yamanaka factors","OSK restores vision in mice","Altos Labs notes","Chemical reprogramming cocktails"]},
     {name:"Information loss", docs:["Information theory of aging","The ICE mouse paper","DNA methylation drift"]}]},
   {name:"Proteostasis", summary:"Keeping proteins folded and recycled: autophagy, mTOR, and aggregates.", groups:[
     {name:"Autophagy", docs:["Autophagy and fasting","Spermidine","mTOR switches off autophagy"]},
     {name:"Aggregates", docs:["Amyloid beyond Alzheimer's","Heat shock proteins"]}]}]},
 {name:"Interventions", hue:152, summary:"Things you can take or do, and how strong the evidence is for each one.", groups:[
   {name:"Drugs", summary:"Prescription drugs with a longevity case: rapamycin, metformin, GLP-1s.", groups:[
     {name:"Rapamycin", docs:["Rapamycin dosing for longevity","My rapamycin side-effects log","ITP rapamycin results","Everolimus immune study"]},
     {name:"Metformin", docs:["TAME trial status","Does metformin blunt exercise gains?","Metformin vs acarbose"]},
     {name:"GLP-1 drugs", docs:["GLP-1 agonists and aging","Semaglutide and muscle loss","Tirzepatide notes"]}]},
   {name:"Supplements", summary:"Split by how well each one is supported in humans.", groups:[
     {name:"Well supported", docs:["Creatine for brain and muscle","Omega-3 dose and index","Vitamin D target levels","Taurine paper (2023)"]},
     {name:"Speculative", docs:["Alpha-ketoglutarate","GlyNAC (glycine + NAC)","Lithium microdose","Why resveratrol faded"]}]},
   {name:"Clinical trials", summary:"Human and dog trials worth following, and how aging trials get designed.", groups:[
     {name:"Trials to watch", docs:["Dog Aging Project TRIAD","PEARL rapamycin trial","XPRIZE Healthspan"]},
     {name:"Trial design", docs:["Surrogate endpoints for aging","Why the FDA won't call aging a disease"]}]}]},
 {name:"Measuring aging", hue:32, summary:"How you would know whether anything is working: clocks, labs, and your own logs.", groups:[
   {name:"Aging clocks", summary:"Methylation and organ clocks, and how far to trust them.", groups:[
     {name:"Methylation clocks", docs:["Horvath clock","GrimAge vs PhenoAge","DunedinPACE","My TruDiagnostic results 2026"]},
     {name:"Other clocks", docs:["Proteomic organ clocks","GlycanAge","Clock reliability problems"]}]},
   {name:"Biomarkers and labs", summary:"Blood tests, fitness numbers, and scans with the strongest link to outcomes.", groups:[
     {name:"Blood labs", docs:["ApoB targets","HbA1c and fasting insulin","hs-CRP","Lp(a) one-time test","Cystatin C for kidneys"]},
     {name:"Fitness markers", docs:["VO2 max percentiles","Grip strength and mortality","Zone 2 lactate testing"]},
     {name:"Imaging", docs:["DEXA body composition","CAC score","Is a full-body MRI worth it?"]}]},
   {name:"My tracking", summary:"Your own numbers over time.", docs:["Quarterly lab log","Sleep tracker comparison","CGM experiment notes","Blood pressure log"]}]},
 {name:"Lifestyle", hue:338, summary:"Daily habits with the biggest effect sizes: exercise first, then sleep and food.", groups:[
   {name:"Exercise", summary:"Cardio for VO2 max and strength to hold on to muscle.", groups:[
     {name:"Cardio", docs:["Zone 2 protocol","Norwegian 4×4 intervals","VO2 max training plan"]},
     {name:"Strength", docs:["Strength training over 40","Protein and muscle synthesis","Sarcopenia"]}]},
   {name:"Nutrition", summary:"Fasting, diet patterns, and the protein question.", groups:[
     {name:"Fasting", docs:["Time-restricted eating","Prolonged fasting risks","Fasting-mimicking diet"]},
     {name:"Diet patterns", docs:["Mediterranean diet evidence","Blue zones critique","Protein restriction vs high protein"]}]},
   {name:"Sleep", summary:"Sleep's role in clearing waste from the brain, and fixes that help.", docs:["Sleep and glymphatic clearance","Sleep apnea screening","Magnesium and sleep","Evening light exposure"]},
   {name:"Mind and social", summary:"Stress, loneliness, and meditation.", docs:["Loneliness and mortality","Stress and telomeres","Meditation evidence"]}]},
 {name:"Building Margin Chat", hue:268, summary:"Product notes for the app you're building: the map, launch, and the editor.", groups:[
   {name:"Map and search", summary:"How people find their way around a large vault.", groups:[
     {name:"Map views", docs:["Zoom ladder brainstorm","Map at millions of notes","Topic boxes design"]},
     {name:"Search", docs:["Vague recall search","Vault search answers"]}]},
   {name:"Launch", summary:"What has to be solid before the launch videos.", groups:[
     {name:"Payments", docs:["Stripe webhooks checklist","Pricing tiers draft"]},
     {name:"Data safety", docs:["Off-site backups","Version history plan"]},
     {name:"Marketing", docs:["Launch video script","Obsidian comparison"]}]},
   {name:"Editor", summary:"Writing and studying inside a note.", docs:["Margin notes vs side docs","Flashcards design","Line authorship"]}]}
]};
