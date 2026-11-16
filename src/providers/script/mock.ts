import type { ScriptRequest, ScriptResult, ScriptWriter } from '../../shared/deps.ts';

const words = (s: string) => s.split(/\s+/).filter(Boolean);

/** Deterministic script built from the stories, sized to roughly the word budget. For dev and tests. */
export class MockScriptWriter implements ScriptWriter {
  async write(req: ScriptRequest): Promise<ScriptResult> {
    const perStory = req.kind === 'extended' ? 130 : 90;
    const used = req.stories.slice(0, Math.max(1, Math.round(req.targetWords / perStory)));
    const opening = `Hello ${req.listenerName}, this is your ${req.slotLabel} bulletin.`;
    const closing = "That's the news for now. Thanks for listening.";
    const budget = Math.max(20, Math.floor((req.targetWords - words(opening).length - words(closing).length) / Math.max(1, used.length)));
    const body = used.map((s, i) => {
      const lead = `${i === 0 ? 'First' : 'Next'}, from ${s.sourceTitle}: ${s.title}.`;
      const rest = words(s.summary).slice(0, Math.max(0, budget - words(lead).length));
      return rest.length ? `${lead} ${rest.join(' ')}` : lead;
    });
    return {
      title: used[0]?.title ?? req.slotLabel,
      script: [opening, ...body, closing].join('\n\n'),
      usedArticleIds: used.map((s) => s.articleId),
    };
  }
}
