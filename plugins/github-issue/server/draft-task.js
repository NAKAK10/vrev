export const ISSUE_DRAFT_START = "VISUAL_REVIEW_ISSUE_DRAFT_START";
export const ISSUE_DRAFT_END = "VISUAL_REVIEW_ISSUE_DRAFT_END";

function requiredText(value, field, maxLength) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be nonblank`);
  const text = value.trim();
  if (text.length > maxLength) throw new Error(`${field} is too long`);
  return text;
}

export function normalizeGitHubIssueDraft(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("issue draft must be an object");
  return { title: requiredText(value.title, "title", 256), body: requiredText(value.body, "body", 65_536) };
}

export function validateStandaloneDraft(annotationId, value) {
  const draft = normalizeGitHubIssueDraft(value);
  const internalReferences = [annotationId, ".vreview/", "Visual Review注釈", "Visual Review annotation"];
  if (internalReferences.some((reference) => draft.title.includes(reference) || draft.body.includes(reference))) {
    throw new Error("Issue draft must be understandable without internal review references");
  }
  return draft;
}

function collectTextOutput(output) {
  const texts = new Set([output]);
  const visit = (value) => {
    if (typeof value === "string") {
      if (!texts.has(value)) { texts.add(value); try { visit(JSON.parse(value)); } catch {} }
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (typeof value === "object" && value !== null) Object.values(value).forEach(visit);
  };
  try { visit(JSON.parse(output)); } catch {}
  for (const line of output.split("\n")) { try { visit(JSON.parse(line)); } catch {} }
  return texts;
}

export function extractIssueDraftOutput(output, allowedAnnotationIds) {
  const drafts = new Map();
  for (const text of collectTextOutput(output)) {
    const pattern = new RegExp(`${ISSUE_DRAFT_START}\\s*([\\s\\S]*?)\\s*${ISSUE_DRAFT_END}`, "g");
    for (const match of text.matchAll(pattern)) {
      try {
        const raw = JSON.parse(match[1]);
        if (typeof raw.annotation_id !== "string" || (allowedAnnotationIds && !allowedAnnotationIds.has(raw.annotation_id))) continue;
        const draft = validateStandaloneDraft(raw.annotation_id, raw);
        drafts.set(raw.annotation_id, { annotationId: raw.annotation_id, ...draft });
      } catch {}
    }
  }
  return [...drafts.values()];
}

export function buildIssueCoordinatorInstructions() {
  return `各annotationをreview fileで確認し、issue_stateがあるIssue用annotationと通常修正を分岐してください。Issue用annotationではsourceを一切編集せず、現在のworking directoryで対象repository・page_path・関連sourceを読み、画像に依存せずrepository相対pathを含む日本語のGitHub Issue title/bodyを作成してください。Issue単体を初めて読む実装者が背景と修正対象を理解できる内容にしてください。annotation ID、review file path、.vreview、Visual Review注釈など内部review情報はtitle/bodyへ書かず、ユーザーの指摘を自然な要件として説明してください。観測事実、期待結果、影響範囲、実装論点、不確定事項、検証可能な受入条件を含め、要件を捏造しないでください。GitHub Issue自体は作成せず、Issue用annotationごとに最終応答へ次の3行だけを必ず出力してください。JSONは1行で、annotation_idは処理対象ID、title/bodyはIssue本文です。この出力をhostが保存するため、Issue用annotationではannotation CLIやshellによる書き込みを実行しません。\n${ISSUE_DRAFT_START}\n{"annotation_id":"<ID>","title":"...","body":"..."}\n${ISSUE_DRAFT_END}`;
}
