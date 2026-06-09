// Digital Product Idea seed library.
// All ideas are purely downloadable / printable / template-based.
// Physical or electronics keywords are intentionally excluded.

export type DigitalFormat =
  | "printable" | "template" | "worksheet" | "planner"
  | "tracker" | "checklist" | "canva_template" | "notion_template"
  | "spreadsheet" | "pdf_guide";

export type DigitalNiche =
  | "parents_kids" | "teachers_homeschool" | "adhd_productivity"
  | "small_business" | "wedding_events" | "health_fitness"
  | "beauty_service" | "real_estate" | "finance_budget" | "holidays_seasonal";

export type DigitalIntentScore = "high" | "medium";

export type DigitalProductIdea = {
  id: string;
  keyword: string;
  audience: string;
  format: DigitalFormat;
  niche: DigitalNiche;
  digital_intent_score: DigitalIntentScore;
  trend_variants: string[];
};

export const FORMAT_META: Record<DigitalFormat, { label: string; emoji: string; token: string }> = {
  printable:        { label: "Printable",        emoji: "🖨️", token: "printable"        },
  template:         { label: "Template",         emoji: "📋", token: "template"         },
  worksheet:        { label: "Worksheet",        emoji: "📝", token: "worksheet"        },
  planner:          { label: "Planner",          emoji: "📅", token: "planner"          },
  tracker:          { label: "Tracker",          emoji: "📊", token: "tracker"          },
  checklist:        { label: "Checklist",        emoji: "✅", token: "checklist"        },
  canva_template:   { label: "Canva Template",   emoji: "🎨", token: "canva template"   },
  notion_template:  { label: "Notion Template",  emoji: "💻", token: "notion template"  },
  spreadsheet:      { label: "Spreadsheet",      emoji: "📊", token: "spreadsheet"      },
  pdf_guide:        { label: "PDF Guide",        emoji: "📖", token: "pdf guide"        },
};

export const NICHE_META: Record<DigitalNiche, { label: string; emoji: string; audience: string }> = {
  parents_kids:         { label: "Parents / Kids",          emoji: "👨‍👧", audience: "Parents"              },
  teachers_homeschool:  { label: "Teachers / Homeschool",   emoji: "🏫", audience: "Teachers"             },
  adhd_productivity:    { label: "ADHD / Productivity",     emoji: "🧠", audience: "ADHD Adults"          },
  small_business:       { label: "Small Business",          emoji: "💼", audience: "Business Owners"      },
  wedding_events:       { label: "Wedding / Events",        emoji: "💍", audience: "Brides & Planners"    },
  health_fitness:       { label: "Health / Fitness",        emoji: "🏃", audience: "Wellness Seekers"     },
  beauty_service:       { label: "Beauty Service Providers",emoji: "💅", audience: "Beauty Professionals" },
  real_estate:          { label: "Real Estate",             emoji: "🏡", audience: "Real Estate Agents"   },
  finance_budget:       { label: "Finance / Budget",        emoji: "💰", audience: "Budget-Conscious"     },
  holidays_seasonal:    { label: "Holidays / Seasonal",     emoji: "🎄", audience: "Holiday Shoppers"     },
};

// Token sets for digital intent detection
export const DIGITAL_INTENT_TOKENS = [
  "printable", "template", "worksheet", "planner", "tracker", "checklist",
  "calendar", "spreadsheet", "notion", "canva", "editable", "download",
  "pdf", "svg", "png", "clipart", "digital paper", "invitation", "mockup",
  "preset", "ebook", "guide", "printout", "workbook",
];

export const PHYSICAL_EXCLUDE_TOKENS = [
  "bluetooth", "speaker", "phone case", "phone cover", "screen",
  "lamp", "chair", "plant", "dress", "shoes", "bag", "necklace",
  "toy", "mug", "shirt", "jewelry", "shipping", "handmade",
  "earrings", "bracelet", "ring", "pillow", "curtain", "vase",
];

export function digitalIntentScore(keyword: string): DigitalIntentScore | null {
  const kw = keyword.toLowerCase();
  if (PHYSICAL_EXCLUDE_TOKENS.some(t => kw.includes(t))) return null;
  if (DIGITAL_INTENT_TOKENS.some(t => kw.includes(t))) return "high";
  return "medium";
}

// ── Seed data ─────────────────────────────────────────────────────────────────

const IDEAS: Omit<DigitalProductIdea, "id">[] = [

  // ── Parents / Kids ──────────────────────────────────────────────────────────
  { keyword: "kids morning routine chart",         audience: "Parents", format: "printable",       niche: "parents_kids",        digital_intent_score: "high",   trend_variants: ["kids morning routine chart printable", "morning routine chart for kids", "toddler morning routine chart", "visual morning routine kids", "morning schedule chart kids"] },
  { keyword: "chore chart for kids",               audience: "Parents", format: "printable",       niche: "parents_kids",        digital_intent_score: "high",   trend_variants: ["chore chart for kids printable", "weekly chore chart kids", "kids chore chart free printable", "toddler chore chart", "chore list for kids"] },
  { keyword: "kids homework planner",              audience: "Parents", format: "planner",         niche: "parents_kids",        digital_intent_score: "high",   trend_variants: ["kids homework planner printable", "homework tracker for kids", "student homework planner", "kids study planner", "after school routine planner"] },
  { keyword: "visual daily schedule for kids",     audience: "Parents", format: "printable",       niche: "parents_kids",        digital_intent_score: "high",   trend_variants: ["visual daily schedule printable kids", "picture schedule for kids", "visual routine chart kids", "daily schedule cards kids", "kids daily routine chart"] },
  { keyword: "potty training reward chart",        audience: "Parents", format: "printable",       niche: "parents_kids",        digital_intent_score: "high",   trend_variants: ["potty training chart printable", "potty training reward sticker chart", "potty training progress chart", "toilet training chart free", "toddler potty chart"] },
  { keyword: "kids reading log printable",         audience: "Parents", format: "worksheet",       niche: "parents_kids",        digital_intent_score: "high",   trend_variants: ["reading log for kids printable", "summer reading log printable", "kids book log template", "reading tracker for kids", "book log printable free"] },
  { keyword: "family meal planner template",       audience: "Parents", format: "template",        niche: "parents_kids",        digital_intent_score: "high",   trend_variants: ["family meal planner template", "weekly meal plan printable family", "family dinner planner", "meal plan template with grocery list", "family weekly menu planner"] },
  { keyword: "abc alphabet practice worksheet",    audience: "Parents", format: "worksheet",       niche: "parents_kids",        digital_intent_score: "high",   trend_variants: ["alphabet practice worksheets free printable", "abc tracing worksheets", "letter practice worksheet kids", "handwriting worksheets kindergarten", "alphabet writing practice"] },
  { keyword: "behavior chart for kids",            audience: "Parents", format: "printable",       niche: "parents_kids",        digital_intent_score: "high",   trend_variants: ["behavior chart for kids printable", "good behavior reward chart", "kids behavior tracker", "daily behavior report card", "classroom behavior chart"] },
  { keyword: "birthday party planning checklist",  audience: "Parents", format: "checklist",       niche: "parents_kids",        digital_intent_score: "high",   trend_variants: ["birthday party planning checklist printable", "kids birthday party checklist", "party planning template", "birthday party planner free", "kids party checklist"] },
  { keyword: "kids allowance tracker",             audience: "Parents", format: "tracker",         niche: "parents_kids",        digital_intent_score: "high",   trend_variants: ["allowance tracker for kids printable", "kids money tracker", "saving chart for kids", "piggy bank tracker printable", "kids spending tracker"] },
  { keyword: "toddler activity schedule",          audience: "Parents", format: "printable",       niche: "parents_kids",        digital_intent_score: "high",   trend_variants: ["toddler activity schedule printable", "toddler daily routine printable", "2 year old activity schedule", "busy toddler schedule", "toddler routine chart"] },

  // ── Teachers / Homeschool ───────────────────────────────────────────────────
  { keyword: "lesson plan template",               audience: "Teachers", format: "template",       niche: "teachers_homeschool", digital_intent_score: "high",   trend_variants: ["lesson plan template free", "weekly lesson plan template", "lesson plan template editable", "homeschool lesson plan template", "daily lesson plan template teacher"] },
  { keyword: "classroom reward chart",             audience: "Teachers", format: "printable",      niche: "teachers_homeschool", digital_intent_score: "high",   trend_variants: ["classroom reward chart printable", "student reward chart teacher", "class reward system printable", "sticker reward chart classroom", "behavior reward chart"] },
  { keyword: "homeschool schedule template",       audience: "Teachers", format: "template",       niche: "teachers_homeschool", digital_intent_score: "high",   trend_variants: ["homeschool schedule template printable", "homeschool daily schedule", "homeschool planner template", "homeschool timetable template", "homeschool routine template"] },
  { keyword: "student progress tracker",           audience: "Teachers", format: "tracker",        niche: "teachers_homeschool", digital_intent_score: "high",   trend_variants: ["student progress tracker template", "student tracking sheet teacher", "academic progress tracker", "reading progress tracker student", "learning progress chart"] },
  { keyword: "classroom newsletter template canva",audience: "Teachers", format: "canva_template", niche: "teachers_homeschool", digital_intent_score: "high",   trend_variants: ["classroom newsletter template canva", "teacher newsletter template", "school newsletter canva template", "weekly classroom newsletter", "parent newsletter template teacher"] },
  { keyword: "reading comprehension worksheet",    audience: "Teachers", format: "worksheet",      niche: "teachers_homeschool", digital_intent_score: "high",   trend_variants: ["reading comprehension worksheets free printable", "reading comprehension passages", "comprehension worksheet grade 2", "short story comprehension worksheet", "reading passage with questions"] },
  { keyword: "teacher grade book spreadsheet",     audience: "Teachers", format: "spreadsheet",    niche: "teachers_homeschool", digital_intent_score: "high",   trend_variants: ["teacher grade book spreadsheet", "gradebook template excel", "grading spreadsheet teacher", "class roster grade tracker", "student grade spreadsheet"] },
  { keyword: "homeschool curriculum planner",      audience: "Teachers", format: "planner",        niche: "teachers_homeschool", digital_intent_score: "high",   trend_variants: ["homeschool curriculum planner printable", "yearly homeschool planner", "homeschool year planner", "homeschool planning binder", "annual homeschool planner"] },
  { keyword: "math practice worksheet printable",  audience: "Teachers", format: "worksheet",      niche: "teachers_homeschool", digital_intent_score: "high",   trend_variants: ["math worksheets printable free", "multiplication worksheet", "addition subtraction worksheet", "math fact practice worksheet", "elementary math worksheet"] },
  { keyword: "classroom rules poster",             audience: "Teachers", format: "printable",      niche: "teachers_homeschool", digital_intent_score: "medium", trend_variants: ["classroom rules poster printable", "classroom rules sign editable", "class rules posters", "school rules poster printable", "classroom management rules poster"] },
  { keyword: "attendance tracker spreadsheet",     audience: "Teachers", format: "spreadsheet",    niche: "teachers_homeschool", digital_intent_score: "high",   trend_variants: ["attendance tracker spreadsheet", "student attendance sheet", "monthly attendance record teacher", "class attendance google sheet", "attendance log printable"] },

  // ── ADHD / Productivity ─────────────────────────────────────────────────────
  { keyword: "ADHD daily planner printable",       audience: "ADHD Adults", format: "planner",    niche: "adhd_productivity",   digital_intent_score: "high",   trend_variants: ["ADHD daily planner printable", "ADHD planner free download", "adult ADHD planner", "executive function planner ADHD", "ADHD productivity planner"] },
  { keyword: "habit tracker printable",            audience: "ADHD Adults", format: "tracker",    niche: "adhd_productivity",   digital_intent_score: "high",   trend_variants: ["habit tracker printable free", "monthly habit tracker", "daily habit tracker template", "habit tracking sheet printable", "30 day habit tracker"] },
  { keyword: "brain dump worksheet",               audience: "ADHD Adults", format: "worksheet",  niche: "adhd_productivity",   digital_intent_score: "high",   trend_variants: ["brain dump worksheet printable", "brain dump template", "brain dump page printable", "mental clutter worksheet", "brain dump journal page"] },
  { keyword: "ADHD morning routine checklist",     audience: "ADHD Adults", format: "checklist",  niche: "adhd_productivity",   digital_intent_score: "high",   trend_variants: ["ADHD morning routine checklist", "morning routine checklist printable", "ADHD routine chart", "executive function checklist morning", "morning steps checklist printable"] },
  { keyword: "weekly planner ADHD printable",      audience: "ADHD Adults", format: "planner",    niche: "adhd_productivity",   digital_intent_score: "high",   trend_variants: ["weekly planner ADHD printable", "ADHD weekly schedule template", "simple weekly planner printable", "undated weekly planner ADHD", "ADHD friendly weekly layout"] },
  { keyword: "time blocking planner template",     audience: "ADHD Adults", format: "template",   niche: "adhd_productivity",   digital_intent_score: "high",   trend_variants: ["time blocking template printable", "time block planner", "daily time blocking worksheet", "schedule blocking template", "time management planner printable"] },
  { keyword: "goal setting worksheet",             audience: "ADHD Adults", format: "worksheet",  niche: "adhd_productivity",   digital_intent_score: "high",   trend_variants: ["goal setting worksheet printable", "smart goals worksheet", "goal planning worksheet free", "goal tracker printable", "vision board goal worksheet"] },
  { keyword: "daily to-do list printable",         audience: "ADHD Adults", format: "printable",  niche: "adhd_productivity",   digital_intent_score: "high",   trend_variants: ["daily to do list printable", "cute to do list printable", "productivity to do list template", "daily task list printable", "priority to do list printable"] },
  { keyword: "focus timer pomodoro printable",     audience: "ADHD Adults", format: "printable",  niche: "adhd_productivity",   digital_intent_score: "high",   trend_variants: ["pomodoro timer printable", "study timer sheet", "focus time tracker printable", "pomodoro planner", "deep work tracker printable"] },
  { keyword: "anxiety journaling prompts pdf",     audience: "ADHD Adults", format: "pdf_guide",  niche: "adhd_productivity",   digital_intent_score: "high",   trend_variants: ["anxiety journal prompts printable", "mental health journal prompts pdf", "therapy journal prompts printable", "coping skills workbook", "anxiety workbook printable free"] },
  { keyword: "notion productivity template",       audience: "ADHD Adults", format: "notion_template", niche: "adhd_productivity", digital_intent_score: "high", trend_variants: ["notion template productivity", "notion daily planner template", "notion ADHD template", "notion task manager template", "notion life planner"] },

  // ── Small Business ──────────────────────────────────────────────────────────
  { keyword: "business invoice template canva",    audience: "Business Owners", format: "canva_template", niche: "small_business", digital_intent_score: "high", trend_variants: ["invoice template canva", "freelance invoice template", "invoice template free editable", "business invoice canva", "small business invoice template"] },
  { keyword: "client onboarding checklist",        audience: "Business Owners", format: "checklist", niche: "small_business",   digital_intent_score: "high",   trend_variants: ["client onboarding checklist template", "new client onboarding packet", "client welcome packet canva", "onboarding process checklist", "client intake form template"] },
  { keyword: "business plan template canva",       audience: "Business Owners", format: "canva_template", niche: "small_business", digital_intent_score: "high", trend_variants: ["business plan template canva", "small business plan template free", "startup business plan canva", "one page business plan template", "business plan presentation canva"] },
  { keyword: "social media content planner",       audience: "Business Owners", format: "planner",   niche: "small_business",   digital_intent_score: "high",   trend_variants: ["social media content planner template", "content calendar template printable", "instagram content planner", "social media content calendar canva", "monthly content planner"] },
  { keyword: "project management notion template", audience: "Business Owners", format: "notion_template", niche: "small_business", digital_intent_score: "high", trend_variants: ["notion project management template", "project tracker notion", "client management notion template", "CRM notion template", "business operations notion"] },
  { keyword: "price list template canva",          audience: "Business Owners", format: "canva_template", niche: "small_business", digital_intent_score: "high", trend_variants: ["price list template canva editable", "service menu template canva", "pricing guide template", "rate card template canva", "pricing sheet template free"] },
  { keyword: "email newsletter template",          audience: "Business Owners", format: "template",  niche: "small_business",   digital_intent_score: "high",   trend_variants: ["email newsletter template canva", "business newsletter template", "email marketing template free", "monthly newsletter template", "business email template"] },
  { keyword: "business expense tracker spreadsheet",audience: "Business Owners",format: "spreadsheet", niche: "small_business",  digital_intent_score: "high",   trend_variants: ["business expense tracker spreadsheet", "small business expense sheet", "monthly expense tracker template", "self employed expense spreadsheet", "freelance income expense tracker"] },
  { keyword: "contract template for creatives",    audience: "Business Owners", format: "template",  niche: "small_business",   digital_intent_score: "medium", trend_variants: ["freelance contract template pdf", "service agreement template", "client contract template free", "photography contract template", "creative services contract"] },
  { keyword: "brand style guide canva template",   audience: "Business Owners", format: "canva_template", niche: "small_business", digital_intent_score: "high", trend_variants: ["brand style guide canva template", "brand kit template", "brand guidelines template", "branding board canva template", "visual identity guide template"] },

  // ── Wedding / Events ─────────────────────────────────────────────────────────
  { keyword: "wedding checklist printable",        audience: "Brides", format: "checklist",       niche: "wedding_events",      digital_intent_score: "high",   trend_variants: ["wedding planning checklist printable", "wedding to do list printable", "bridal planning checklist", "wedding countdown checklist", "wedding day checklist free"] },
  { keyword: "wedding seating chart template canva",audience: "Brides", format: "canva_template", niche: "wedding_events",      digital_intent_score: "high",   trend_variants: ["wedding seating chart canva template", "seating chart editable template", "wedding seating plan canva", "reception seating chart template", "seating arrangement template canva"] },
  { keyword: "wedding budget tracker spreadsheet", audience: "Brides", format: "spreadsheet",     niche: "wedding_events",      digital_intent_score: "high",   trend_variants: ["wedding budget spreadsheet free", "wedding budget tracker template", "wedding cost tracker excel", "wedding expense spreadsheet", "bridal budget planner"] },
  { keyword: "digital wedding invitation template",audience: "Brides", format: "template",        niche: "wedding_events",      digital_intent_score: "high",   trend_variants: ["digital wedding invitation template canva", "editable wedding invitation", "wedding invitation template free", "canva wedding invite template", "printable wedding invitation"] },
  { keyword: "party planning template",            audience: "Event Planners", format: "template", niche: "wedding_events",      digital_intent_score: "high",   trend_variants: ["party planning template printable", "event planning checklist template", "birthday party planner template", "party planning spreadsheet", "event checklist template"] },
  { keyword: "wedding timeline template",          audience: "Brides", format: "template",        niche: "wedding_events",      digital_intent_score: "high",   trend_variants: ["wedding day timeline template", "wedding timeline template canva", "wedding day schedule template", "ceremony timeline template", "wedding day itinerary template"] },
  { keyword: "bridal shower game printable",       audience: "Brides", format: "printable",       niche: "wedding_events",      digital_intent_score: "high",   trend_variants: ["bridal shower games printable free", "bridal shower activities printable", "bridal shower bingo printable", "bridal games printable", "hen party games printable"] },
  { keyword: "event venue comparison spreadsheet", audience: "Event Planners", format: "spreadsheet", niche: "wedding_events",   digital_intent_score: "high",   trend_variants: ["venue comparison spreadsheet template", "wedding venue comparison checklist", "event venue checklist", "venue comparison worksheet", "venue selection template"] },

  // ── Health / Fitness ─────────────────────────────────────────────────────────
  { keyword: "workout log printable",              audience: "Fitness Enthusiasts", format: "printable", niche: "health_fitness", digital_intent_score: "high",  trend_variants: ["workout log printable free", "gym workout tracker printable", "fitness log template", "exercise journal printable", "weight training log printable"] },
  { keyword: "meal prep planner template",         audience: "Health Conscious", format: "planner",   niche: "health_fitness",   digital_intent_score: "high",   trend_variants: ["meal prep planner printable", "weekly meal prep template", "meal planning worksheet", "healthy meal plan template", "meal prep schedule printable"] },
  { keyword: "weight loss tracker printable",      audience: "Fitness Enthusiasts", format: "tracker", niche: "health_fitness",  digital_intent_score: "high",   trend_variants: ["weight loss tracker printable free", "weight tracking chart printable", "weight loss progress chart", "monthly weight tracker", "BMI tracker printable"] },
  { keyword: "30 day fitness challenge printable", audience: "Fitness Enthusiasts", format: "printable", niche: "health_fitness", digital_intent_score: "high",  trend_variants: ["30 day fitness challenge printable", "30 day workout challenge chart", "fitness challenge tracker", "30 day exercise chart", "monthly workout challenge printable"] },
  { keyword: "self care checklist printable",      audience: "Wellness Seekers", format: "checklist",  niche: "health_fitness",   digital_intent_score: "high",   trend_variants: ["self care checklist printable", "self care routine checklist", "mental health checklist", "daily self care list printable", "wellness checklist printable"] },
  { keyword: "nutrition tracker spreadsheet",      audience: "Health Conscious", format: "spreadsheet",niche: "health_fitness",   digital_intent_score: "high",   trend_variants: ["nutrition tracker spreadsheet", "calorie tracker spreadsheet", "macro tracking spreadsheet", "food diary spreadsheet", "daily nutrition log template"] },
  { keyword: "gratitude journal printable",        audience: "Wellness Seekers", format: "printable", niche: "health_fitness",   digital_intent_score: "high",   trend_variants: ["gratitude journal printable free", "daily gratitude log printable", "gratitude page printable", "5 minute journal printable", "mindfulness journal printable"] },
  { keyword: "sleep tracker printable",            audience: "Wellness Seekers", format: "tracker",   niche: "health_fitness",   digital_intent_score: "high",   trend_variants: ["sleep tracker printable", "sleep log printable", "sleep quality tracker", "monthly sleep tracker", "sleep journal printable"] },

  // ── Beauty Service Providers ─────────────────────────────────────────────────
  { keyword: "nail tech appointment card canva",   audience: "Nail Techs", format: "canva_template", niche: "beauty_service",  digital_intent_score: "high",   trend_variants: ["nail appointment card canva template", "nail tech business card canva", "nail salon appointment reminder", "nail art menu canva template", "salon appointment card template"] },
  { keyword: "lash tech price list canva",         audience: "Lash Artists", format: "canva_template", niche: "beauty_service", digital_intent_score: "high",   trend_variants: ["lash tech price menu canva", "eyelash extension price list template", "lash menu canva editable", "lash artist price guide canva", "lash business menu template"] },
  { keyword: "salon service menu template",        audience: "Salon Owners", format: "canva_template", niche: "beauty_service", digital_intent_score: "high",   trend_variants: ["hair salon menu template canva", "beauty salon price list canva", "salon menu editable template", "hair color price list template", "salon services menu design"] },
  { keyword: "client intake form beauty",          audience: "Beauty Professionals", format: "template", niche: "beauty_service", digital_intent_score: "high", trend_variants: ["beauty client intake form", "salon client consultation form", "skin consultation form printable", "esthetician client intake form", "brow artist intake form"] },
  { keyword: "esthetician aftercare guide pdf",    audience: "Estheticians", format: "pdf_guide",    niche: "beauty_service",   digital_intent_score: "high",   trend_variants: ["esthetician aftercare instructions pdf", "facial aftercare guide printable", "skin treatment aftercare card", "chemical peel aftercare printable", "microneedling aftercare sheet"] },
  { keyword: "nail art design chart printable",    audience: "Nail Techs", format: "printable",      niche: "beauty_service",   digital_intent_score: "high",   trend_variants: ["nail shape chart printable", "nail design menu printable", "nail art inspiration board printable", "nail color chart printable", "gel nail chart printable"] },
  { keyword: "beauty business notion template",    audience: "Beauty Professionals", format: "notion_template", niche: "beauty_service", digital_intent_score: "high", trend_variants: ["beauty business notion template", "salon management notion", "lash business tracker notion", "beauty client tracker notion", "nail tech client management notion"] },

  // ── Real Estate ──────────────────────────────────────────────────────────────
  { keyword: "home buyer guide pdf",               audience: "Real Estate Agents", format: "pdf_guide", niche: "real_estate",   digital_intent_score: "high",   trend_variants: ["first time home buyer guide pdf", "home buyer checklist printable", "home buying process guide", "home buyer handbook pdf free", "real estate buyer guide template"] },
  { keyword: "home showing checklist printable",   audience: "Real Estate Agents", format: "checklist", niche: "real_estate",   digital_intent_score: "high",   trend_variants: ["home showing checklist printable", "open house checklist template", "house showing notes template", "property showing form", "home tour checklist printable"] },
  { keyword: "real estate listing presentation canva", audience: "Real Estate Agents", format: "canva_template", niche: "real_estate", digital_intent_score: "high", trend_variants: ["real estate listing presentation canva", "listing presentation template free", "realtor presentation canva", "property listing template canva", "real estate pitch deck canva"] },
  { keyword: "rental property tracker spreadsheet",audience: "Landlords", format: "spreadsheet",     niche: "real_estate",      digital_intent_score: "high",   trend_variants: ["rental property spreadsheet", "landlord expense tracker", "rental income tracker spreadsheet", "property management spreadsheet", "rental income expense sheet"] },
  { keyword: "home renovation budget spreadsheet", audience: "Homeowners", format: "spreadsheet",    niche: "real_estate",      digital_intent_score: "high",   trend_variants: ["home renovation budget spreadsheet", "remodel budget tracker", "home improvement budget template", "renovation cost spreadsheet", "home project budget planner"] },
  { keyword: "new home checklist printable",       audience: "Homeowners", format: "checklist",      niche: "real_estate",      digital_intent_score: "high",   trend_variants: ["new home checklist printable", "moving into new home checklist", "new homeowner checklist", "first home checklist", "house moving checklist printable"] },

  // ── Finance / Budget ─────────────────────────────────────────────────────────
  { keyword: "monthly budget printable",           audience: "Budget-Conscious", format: "printable", niche: "finance_budget",   digital_intent_score: "high",   trend_variants: ["monthly budget printable free", "printable budget sheet", "household budget printable", "personal budget worksheet free", "monthly spending tracker printable"] },
  { keyword: "debt payoff tracker printable",      audience: "Budget-Conscious", format: "tracker",   niche: "finance_budget",   digital_intent_score: "high",   trend_variants: ["debt payoff tracker printable", "debt snowball worksheet", "debt avalanche printable", "debt free tracker printable", "debt paydown chart free"] },
  { keyword: "savings tracker printable",          audience: "Budget-Conscious", format: "tracker",   niche: "finance_budget",   digital_intent_score: "high",   trend_variants: ["savings tracker printable free", "money saving chart printable", "savings goal tracker", "vacation savings tracker", "savings challenge printable"] },
  { keyword: "budget planner notion template",     audience: "Budget-Conscious", format: "notion_template", niche: "finance_budget", digital_intent_score: "high", trend_variants: ["notion budget template", "notion finance tracker", "personal finance notion template", "budget tracker notion", "monthly budget notion template"] },
  { keyword: "financial goals worksheet",          audience: "Budget-Conscious", format: "worksheet", niche: "finance_budget",   digital_intent_score: "high",   trend_variants: ["financial goals worksheet printable", "money goals worksheet", "financial planning worksheet free", "savings goal worksheet", "year of finance worksheet"] },
  { keyword: "bill payment tracker printable",     audience: "Budget-Conscious", format: "tracker",   niche: "finance_budget",   digital_intent_score: "high",   trend_variants: ["bill payment tracker printable", "monthly bills checklist printable", "bill payment schedule template", "bill organizer printable free", "monthly expenses tracker"] },
  { keyword: "sinking fund tracker printable",     audience: "Budget-Conscious", format: "tracker",   niche: "finance_budget",   digital_intent_score: "high",   trend_variants: ["sinking fund tracker printable", "sinking fund spreadsheet", "category savings tracker", "budget category tracker", "fund savings chart printable"] },
  { keyword: "small business budget spreadsheet",  audience: "Business Owners", format: "spreadsheet", niche: "finance_budget",  digital_intent_score: "high",   trend_variants: ["small business budget spreadsheet free", "startup budget template", "business financial plan spreadsheet", "monthly business budget template", "profit loss spreadsheet small business"] },

  // ── Holidays / Seasonal ──────────────────────────────────────────────────────
  { keyword: "christmas gift list printable",      audience: "Holiday Shoppers", format: "printable", niche: "holidays_seasonal", digital_intent_score: "high",  trend_variants: ["christmas gift list printable free", "holiday gift tracker printable", "Christmas shopping list printable", "gift giving list template", "christmas wish list printable"] },
  { keyword: "holiday bucket list printable",      audience: "Holiday Shoppers", format: "printable", niche: "holidays_seasonal", digital_intent_score: "high",  trend_variants: ["christmas bucket list printable", "holiday activities checklist", "winter bucket list printable", "holiday to do list printable", "Christmas activities list printable"] },
  { keyword: "thanksgiving dinner planner",        audience: "Home Cooks", format: "planner",         niche: "holidays_seasonal", digital_intent_score: "high",  trend_variants: ["thanksgiving dinner planning template", "thanksgiving menu planner printable", "holiday dinner prep checklist", "thanksgiving day planner printable", "holiday meal planner printable"] },
  { keyword: "halloween costume planner",          audience: "Parents", format: "printable",          niche: "holidays_seasonal", digital_intent_score: "medium", trend_variants: ["halloween costume ideas printable", "halloween planner printable", "holiday activity planner", "halloween party planning checklist", "spooky season planner printable"] },
  { keyword: "christmas countdown calendar printable", audience: "Holiday Shoppers", format: "printable", niche: "holidays_seasonal", digital_intent_score: "high", trend_variants: ["advent calendar printable", "christmas countdown printable", "DIY advent calendar template", "countdown to christmas printable", "24 day advent printable"] },
  { keyword: "new year resolution worksheet",      audience: "Goal Setters", format: "worksheet",     niche: "holidays_seasonal", digital_intent_score: "high",  trend_variants: ["new year resolution printable", "new year goals worksheet", "new year reflection worksheet", "goal setting printable new year", "year in review worksheet printable"] },
  { keyword: "valentine's day card template",      audience: "Couples", format: "template",           niche: "holidays_seasonal", digital_intent_score: "high",  trend_variants: ["valentines card template printable", "valentines day printable free", "love coupon template printable", "valentines gift voucher printable", "valentines day activities printable"] },
  { keyword: "back to school checklist",           audience: "Parents", format: "checklist",          niche: "holidays_seasonal", digital_intent_score: "high",  trend_variants: ["back to school supply checklist", "back to school printable checklist", "school supply list printable", "back to school planner printable", "first day of school checklist"] },
];

// Attach stable IDs
export const DIGITAL_PRODUCT_IDEAS: DigitalProductIdea[] = IDEAS.map((idea, i) => ({
  ...idea,
  id: `dp_${i.toString().padStart(3, "0")}`,
}));

export const ALL_NICHES = Object.keys(NICHE_META) as DigitalNiche[];
export const ALL_FORMATS = Object.keys(FORMAT_META) as DigitalFormat[];
