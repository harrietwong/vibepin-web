import type { LanguageCode } from "./config";
import { contentLanguageLabel } from "./config";

type TitlePatternOpts = {
  kw: string;
  audience: string;
  room: string;
  style: string;
  productTitle: string;
  pinIndex: number;
};

type DescPatternOpts = {
  kw: string;
  catLabel: string;
  mood: string;
  promptSnippet: string;
};

type AltPatternOpts = {
  subject: string;
  mood: string;
  pinIndex: number;
};

const EN: {
  audience: (category: string) => string;
  titles: (o: TitlePatternOpts) => string[];
  descriptions: (o: DescPatternOpts) => string[];
  alt: (o: AltPatternOpts) => string[];
} = {
  audience: (category) => {
    const c = category.toLowerCase();
    if (c.includes("fashion") || c.includes("apparel")) return "your wardrobe";
    if (c.includes("wedding")) return "your big day";
    if (c.includes("food")) return "your kitchen";
    if (c.includes("garden")) return "your garden";
    return "your home";
  },
  titles: ({ kw, audience, room, style, productTitle }) => [
    `${kw} Ideas for ${audience}`,
    `${style} ${room} Inspiration`,
    `Best ${productTitle || kw} Finds for ${audience}`,
    productTitle
      ? `How to Style ${productTitle} in a ${style} Space`
      : `How to Style ${kw} in a ${style} Space`,
    `${kw} Ideas to Try This Week`,
    `${kw}: ${style} Pinterest Inspiration`,
  ],
  descriptions: ({ kw, catLabel, mood, promptSnippet }) => [
    `Save these ${kw} ideas for your next ${catLabel} refresh. This pin captures a ${mood} look with Pinterest-native styling — perfect for mood boards and weekly inspiration.`,
    `Looking for ${kw} inspiration? This ${mood} pin blends natural light, thoughtful composition, and save-worthy details. Tap to save and revisit when you plan your next post.`,
    promptSnippet
      ? `${promptSnippet.slice(0, 120).trim()}… Discover ${kw} ideas that feel fresh, polished, and ready for your Pinterest boards.`
      : `Discover beautiful ${kw} ideas for your ${catLabel} space. Save this pin for your next project and get inspired!`,
  ],
  alt: ({ subject, mood, pinIndex }) => {
    const variants = [
      `Vertical Pinterest pin showing ${subject} in a ${mood} setting with soft natural lighting.`,
      `Aesthetic ${mood} photo featuring ${subject}, composed for Pinterest with editorial styling.`,
      `Save-worthy ${subject} inspiration image with ${mood} composition and warm tones.`,
    ];
    return [variants[pinIndex % variants.length]];
  },
};

const ZH_CN = {
  audience: () => "你的空间",
  titles: ({ kw, style, productTitle }: TitlePatternOpts) => [
    `${kw}灵感合集`,
    `${style}${kw}搭配灵感`,
    `本周必看的${productTitle || kw}精选`,
    productTitle ? `${productTitle}的${style}风格搭配` : `${kw}的${style}风格灵感`,
    `${kw}创意灵感 · 本周推荐`,
    `${kw} · Pinterest 美学灵感`,
  ],
  descriptions: ({ kw, catLabel, mood }: DescPatternOpts) => [
    `收藏这些${kw}灵感，为你的${catLabel}空间带来全新氛围。这张 Pin 呈现${mood}风格，适合灵感板和周计划。`,
    `正在寻找${kw}灵感？这张${mood}风格的 Pin 融合自然光线与精致构图，值得收藏。`,
    `发现更多${kw}创意，适合你的${catLabel}项目。保存这张 Pin，随时获取灵感！`,
  ],
  alt: ({ subject, mood }: AltPatternOpts) => [
    `竖版 Pinterest Pin，展示${subject}的${mood}风格场景。`,
  ],
};

const ZH_TW = {
  audience: () => "你的空間",
  titles: ({ kw, style, productTitle }: TitlePatternOpts) => [
    `${kw}靈感合集`,
    `${style}${kw}搭配靈感`,
    `本週必看的${productTitle || kw}精選`,
    productTitle ? `${productTitle}的${style}風格搭配` : `${kw}的${style}風格靈感`,
    `${kw}創意靈感 · 本週推薦`,
    `${kw} · Pinterest 美學靈感`,
  ],
  descriptions: ({ kw, catLabel, mood }: DescPatternOpts) => [
    `收藏這些${kw}靈感，為你的${catLabel}空間帶來全新氛圍。這張 Pin 呈現${mood}風格，適合靈感板與週計畫。`,
    `正在尋找${kw}靈感？這張${mood}風格的 Pin 融合自然光線與精緻構圖，值得收藏。`,
    `發現更多${kw}創意，適合你的${catLabel}專案。儲存這張 Pin，隨時獲取靈感！`,
  ],
  alt: ({ subject, mood }: AltPatternOpts) => [
    `直式 Pinterest Pin，展示${subject}的${mood}風格場景。`,
  ],
};

const JA = {
  audience: () => "あなたの空間",
  titles: ({ kw, productTitle }: TitlePatternOpts) => [
    `${kw}のアイデア集`,
    `${productTitle || kw}のインスピレーション`,
    `今週試したい${kw}アイデア`,
    `${kw}のPinterestスタイル`,
    `${kw}コーディネートのヒント`,
    `${kw} · 保存したくなるピン`,
  ],
  descriptions: ({ kw, catLabel, mood }: DescPatternOpts) => [
    `${kw}のアイデアを保存して、${catLabel}の刷新に役立てましょう。このピンは${mood}な雰囲気で、週間インスピレーションに最適です。`,
    `${kw}のインスピレーションを探していますか？${mood}な構図と自然光が魅力のピンです。`,
    `${catLabel}向けの${kw}アイデアを発見。次の投稿計画に保存してください。`,
  ],
  alt: ({ subject, mood }: AltPatternOpts) => [`${subject}の${mood}なPinterestピン画像。`],
};

const KO = {
  audience: () => "당신의 공간",
  titles: ({ kw, productTitle }: TitlePatternOpts) => [
    `${kw} 아이디어 모음`,
    `${productTitle || kw} 영감 핀`,
    `이번 주 ${kw} 추천`,
    `${kw} Pinterest 스타일`,
    `${kw} 스타일링 팁`,
    `${kw} · 저장하고 싶은 핀`,
  ],
  descriptions: ({ kw, catLabel, mood }: DescPatternOpts) => [
    `${kw} 아이디어를 저장해 ${catLabel} 공간을 새롭게 꾸며보세요. ${mood} 분위기의 Pinterest 핀입니다.`,
    `${kw} 영감을 찾고 있나요? ${mood} 구도와 자연광이 돋보이는 핀입니다.`,
    `${catLabel}에 어울리는 ${kw} 아이디어를 발견하세요. 저장해 두었다가 계획에 활용하세요.`,
  ],
  alt: ({ subject, mood }: AltPatternOpts) => [`${subject}의 ${mood} Pinterest 핀 이미지.`],
};

const ES = {
  audience: () => "tu espacio",
  titles: ({ kw, productTitle, style, audience }: TitlePatternOpts) => [
    `Ideas de ${kw} para ${audience}`,
    `Inspiración ${style} de ${kw}`,
    `Mejores ideas de ${productTitle || kw}`,
    `Cómo estilizar ${productTitle || kw} con estilo ${style}`,
    `Ideas de ${kw} para esta semana`,
    `${kw}: inspiración Pinterest ${style}`,
  ],
  descriptions: ({ kw, catLabel, mood }: DescPatternOpts) => [
    `Guarda estas ideas de ${kw} para renovar tu ${catLabel}. Este pin captura un look ${mood} perfecto para tableros de inspiración.`,
    `¿Buscas inspiración de ${kw}? Este pin ${mood} combina luz natural y composición cuidada.`,
    `Descubre ideas de ${kw} para tu espacio ${catLabel}. ¡Guárdalo para tu próximo proyecto!`,
  ],
  alt: ({ subject, mood }: AltPatternOpts) => [`Pin vertical de Pinterest con ${subject} en un estilo ${mood}.`],
};

const FR = {
  audience: () => "votre espace",
  titles: ({ kw, productTitle, style, audience }: TitlePatternOpts) => [
    `Idées ${kw} pour ${audience}`,
    `Inspiration ${style} ${kw}`,
    `Meilleures idées ${productTitle || kw}`,
    `Comment styliser ${productTitle || kw} en style ${style}`,
    `Idées ${kw} à essayer cette semaine`,
    `${kw} : inspiration Pinterest ${style}`,
  ],
  descriptions: ({ kw, catLabel, mood }: DescPatternOpts) => [
    `Enregistrez ces idées ${kw} pour rafraîchir votre ${catLabel}. Ce pin capture un look ${mood} idéal pour vos tableaux.`,
    `Vous cherchez de l'inspiration ${kw} ? Ce pin ${mood} allie lumière naturelle et composition soignée.`,
    `Découvrez de belles idées ${kw} pour votre espace ${catLabel}.`,
  ],
  alt: ({ subject, mood }: AltPatternOpts) => [`Pin Pinterest vertical montrant ${subject} dans un style ${mood}.`],
};

const DE = {
  audience: () => "dein Zuhause",
  titles: ({ kw, productTitle, style, audience }: TitlePatternOpts) => [
    `${kw}-Ideen für ${audience}`,
    `${style} ${kw}-Inspiration`,
    `Beste ${productTitle || kw}-Ideen`,
    `So stylst du ${productTitle || kw} im ${style} Stil`,
    `${kw}-Ideen für diese Woche`,
    `${kw}: ${style} Pinterest-Inspiration`,
  ],
  descriptions: ({ kw, catLabel, mood }: DescPatternOpts) => [
    `Speichere diese ${kw}-Ideen für dein nächstes ${catLabel}-Update. Dieser Pin zeigt einen ${mood} Look.`,
    `Suchst du ${kw}-Inspiration? Dieser ${mood} Pin kombiniert natürliches Licht und starke Komposition.`,
    `Entdecke schöne ${kw}-Ideen für deinen ${catLabel}-Bereich.`,
  ],
  alt: ({ subject, mood }: AltPatternOpts) => [`Vertikaler Pinterest-Pin mit ${subject} im ${mood} Stil.`],
};

const PT = {
  audience: () => "seu espaço",
  titles: ({ kw, productTitle, style, audience }: TitlePatternOpts) => [
    `Ideias de ${kw} para ${audience}`,
    `Inspiração ${style} de ${kw}`,
    `Melhores ideias de ${productTitle || kw}`,
    `Como estilizar ${productTitle || kw} com estilo ${style}`,
    `Ideias de ${kw} para esta semana`,
    `${kw}: inspiração Pinterest ${style}`,
  ],
  descriptions: ({ kw, catLabel, mood }: DescPatternOpts) => [
    `Salve estas ideias de ${kw} para renovar seu ${catLabel}. Este pin captura um visual ${mood}.`,
    `Procurando inspiração de ${kw}? Este pin ${mood} combina luz natural e composição cuidadosa.`,
    `Descubra ideias de ${kw} para seu espaço ${catLabel}.`,
  ],
  alt: ({ subject, mood }: AltPatternOpts) => [`Pin vertical do Pinterest mostrando ${subject} em estilo ${mood}.`],
};

type TemplateSet = typeof EN;

const TEMPLATES: Partial<Record<LanguageCode, TemplateSet>> = {
  en: EN,
  "zh-CN": ZH_CN as TemplateSet,
  "zh-TW": ZH_TW as TemplateSet,
  ja: JA as TemplateSet,
  ko: KO as TemplateSet,
  es: ES as TemplateSet,
  fr: FR as TemplateSet,
  de: DE as TemplateSet,
  pt: PT as TemplateSet,
};

export function getContentTemplates(lang: LanguageCode): TemplateSet {
  return TEMPLATES[lang] ?? EN;
}

/** Per-language word for "Inspiration" used in fallback title fillers. */
export const LANG_FILLER_WORD: Partial<Record<LanguageCode, string>> = {
  en: "Inspiration",
  "zh-CN": "灵感精选",
  "zh-TW": "靈感精選",
  ja: "インスピレーション",
  ko: "영감 모음",
  es: "Inspiración",
  fr: "Inspiration",
  de: "Inspiration",
  pt: "Inspiração",
  ru: "Вдохновение",
  it: "Ispirazione",
  nl: "Inspiratie",
  pl: "Inspiracja",
  tr: "İlham",
  vi: "Cảm hứng",
  th: "แรงบันดาลใจ",
  id: "Inspirasi",
};

/** Per-language word for "Ideas" used in board suggestion labels. */
export const LANG_IDEAS_WORD: Partial<Record<LanguageCode, string>> = {
  en: "Ideas",
  "zh-CN": "灵感",
  "zh-TW": "靈感",
  ja: "アイデア",
  ko: "아이디어",
  es: "Ideas",
  fr: "Idées",
  de: "Ideen",
  pt: "Ideias",
  ru: "Идеи",
  it: "Idee",
  nl: "Ideeën",
  pl: "Pomysły",
  tr: "Fikirler",
  vi: "Ý tưởng",
  th: "ไอเดีย",
  id: "Ide",
};

export function contentLanguagePromptHint(lang: LanguageCode): string {
  const label = contentLanguageLabel(lang);
  return `\n\n[Important: Write all Pin titles, descriptions, and alt text in ${label} only. Do not mix languages. Do not use the app UI language unless it matches ${label}.]`;
}
