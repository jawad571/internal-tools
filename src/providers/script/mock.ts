import { joinSegments, type ScriptRequest, type ScriptResult, type ScriptSegment, type ScriptWriter } from '../../shared/deps.ts';

const words = (s: string) => s.split(/\s+/).filter(Boolean);

/** Fixed phrases per language. Languages without an entry get English. */
const PHRASES = {
  en: {
    opening: (name: string, slot: string) => `Hello ${name}, this is your ${slot} bulletin.`,
    closing: "That's the news for now. Thanks for listening.",
    lead: (first: boolean, source: string, title: string) => `${first ? 'First' : 'Next'}, from ${source}: ${title}.`,
    /** null = use the story's own summary words. */
    filler: null as string[] | null,
    title: null as string | null,
    titleEn: null as string | null,
  },
  ur: {
    opening: (name: string, slot: string) => `السلام علیکم ${name}، ${slot} کے خبرنامے میں خوش آمدید۔`,
    closing: 'یہ تھیں اس وقت کی خبریں۔ سننے کا شکریہ، اپنا خیال رکھیے، اللہ حافظ۔',
    // Source and headline stay as supplied (Latin) — the real writer transliterates; the mock just keeps them findable.
    lead: (first: boolean, source: string, title: string) => `${first ? 'پہلی خبر' : 'اب اگلی خبر'}، ${source} کے مطابق: ${title}۔`,
    filler: [
      'تفصیلات کے مطابق اس معاملے پر مزید معلومات آنے والے دنوں میں سامنے آئیں گی۔',
      'حکام کا کہنا ہے کہ صورتحال پر مسلسل نظر رکھی جا رہی ہے۔',
      'ماہرین کے مطابق اس کے اثرات دور رس ہو سکتے ہیں۔',
      'عوام کی بڑی تعداد نے اس پیش رفت پر ملے جلے ردعمل کا اظہار کیا ہے۔',
    ],
    title: 'اس گھنٹے کی اہم خبریں',
    titleEn: "This hour's top stories",
  },
};

/** Deterministic script built from the stories, sized to roughly the word budget. For dev and tests. */
export class MockScriptWriter implements ScriptWriter {
  async write(req: ScriptRequest): Promise<ScriptResult> {
    const lang = req.language === 'ur' ? PHRASES.ur : PHRASES.en;
    const perStory = req.kind === 'extended' ? 130 : 90;
    const used = req.stories.slice(0, Math.max(1, Math.round(req.targetWords / perStory)));
    const opening = lang.opening(req.listenerName, req.slotLabel);
    const closing = lang.closing;
    const budget = Math.max(20, Math.floor((req.targetWords - words(opening).length - words(closing).length) / Math.max(1, used.length)));
    const filler = lang.filler ? words(lang.filler.join(' ')) : null;
    const body = used.map((s, i): ScriptSegment => {
      const lead = lang.lead(i === 0, s.sourceTitle, s.title);
      const n = Math.max(0, budget - words(lead).length);
      const pool = filler ?? words(s.summary);
      // Filler repeats to size; a summary is only ever truncated.
      const rest = filler ? Array.from({ length: n }, (_, k) => pool[k % pool.length]!) : pool.slice(0, n);
      return { articleId: s.articleId, text: rest.length ? `${lead} ${rest.join(' ')}` : lead };
    });
    const segments: ScriptSegment[] = [{ articleId: null, text: opening }, ...body, { articleId: null, text: closing }];
    return {
      title: lang.title ?? used[0]?.title ?? req.slotLabel,
      ...(lang.titleEn ? { titleEn: lang.titleEn } : {}),
      script: joinSegments(segments),
      segments,
      usedArticleIds: used.map((s) => s.articleId),
    };
  }
}
