import { Router } from 'express';
import { queryAll, queryOne, runSQL } from '../db.js';
import { callGemini } from '../services/gemini-service.js';

const router = Router();

// ============================
// group_tag 컬럼 마이그레이션
// ============================
try {
  const tableInfo = queryAll('PRAGMA table_info(topic_recommendations)', []);
  const hasGroupTag = tableInfo.some(col => col.name === 'group_tag');
  if (!hasGroupTag) {
    runSQL('ALTER TABLE topic_recommendations ADD COLUMN group_tag TEXT DEFAULT NULL');
    console.log('[DB] topic_recommendations에 group_tag 컬럼 추가 완료');
  }
} catch(e) {
  console.error('[DB] group_tag 컬럼 추가 실패:', e.message);
}

// 5단계 컬럼 마이그레이션
try {
  const tblInfo = queryAll('PRAGMA table_info(topic_recommendations)', []);
  const colNames = tblInfo.map(c => c.name);
  if (!colNames.includes('thumb_title_main')) {
    runSQL("ALTER TABLE topic_recommendations ADD COLUMN thumb_title_main TEXT DEFAULT ''");
    console.log('[DB] topic_recommendations에 thumb_title_main 컬럼 추가');
  }
  if (!colNames.includes('selected_dna_id')) {
    runSQL('ALTER TABLE topic_recommendations ADD COLUMN selected_dna_id INTEGER');
    console.log('[DB] topic_recommendations에 selected_dna_id 컬럼 추가');
  }
  if (!colNames.includes('story_prompt')) {
    runSQL("ALTER TABLE topic_recommendations ADD COLUMN story_prompt TEXT DEFAULT ''");
    console.log('[DB] topic_recommendations에 story_prompt 컬럼 추가');
  }
  if (!colNames.includes('story_guideline_id')) {
    runSQL('ALTER TABLE topic_recommendations ADD COLUMN story_guideline_id INTEGER');
    console.log('[DB] topic_recommendations에 story_guideline_id 컬럼 추가');
  }
} catch(e) {
  console.error('[DB] 5단계 컬럼 추가 실패:', e.message);
}

try {
  const nullRows = queryAll("SELECT COUNT(*) as cnt FROM topic_recommendations WHERE group_tag IS NULL", []);
  if (nullRows[0].cnt > 0) {
    const cats = queryAll("SELECT DISTINCT name, genre FROM categories", []);
    cats.forEach(function(c) {
      runSQL(
        "UPDATE topic_recommendations SET group_tag = ? WHERE category = ? AND group_tag IS NULL",
        [c.genre, c.name]
      );
    });
    console.log('[DB] 기존 이력 group_tag 역매핑 완료');
  }
} catch(e) {
  console.error('[DB] group_tag 역매핑 실패:', e.message);
}



// ============================
// POST /api/topics/save-recommendation — 주제 추천 최종 저장
// ============================
router.post('/save-recommendation', (req, res) => {
  try {
    const { topic_title, topic_summary, thumb_titles, group_tag,
            thumb_title_main, selected_dna_id, story_prompt, story_guideline_id } = req.body;

    if (!topic_title || !topic_title.trim()) {
      return res.status(400).json({ error: 'topic_title은 필수입니다.' });
    }
    if (!topic_summary || !topic_summary.trim()) {
      return res.status(400).json({ error: 'topic_summary는 필수입니다.' });
    }

    const thumbJson = JSON.stringify(
      Array.isArray(thumb_titles) ? thumb_titles : [thumb_titles || '']
    );

    const result = runSQL(
      `INSERT INTO topic_recommendations
         (category, group_tag, topic_title, topic_summary, thumb_titles,
          thumb_title_main, selected_dna_id, story_prompt, story_guideline_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))`,
      [group_tag || '', group_tag || '', topic_title.trim(), topic_summary.trim(), thumbJson,
       thumb_title_main || '', selected_dna_id || null, story_prompt || '', story_guideline_id || null]
    );

    res.json({ success: true, id: result.lastId });
  } catch (e) {
    console.error('[save-recommendation 오류]', e);
    res.status(500).json({ error: e.message });
  }
});

// ============================
// GET /api/topics/top200-titles — 장르별 TOP200 떡상 제목 조회
// ============================
router.get('/top200-titles', (req, res) => {
  try {
    const { genre } = req.query;
    const rows = queryAll(`
      SELECT v.title, MAX(vsr.spike_ratio) as spike_ratio
      FROM video_spike_rankings vsr
      JOIN videos v ON v.id = vsr.video_id
      WHERE vsr.is_spike = 1${genre ? ' AND vsr.genre = ?' : ''}
      GROUP BY vsr.video_id
      ORDER BY spike_ratio DESC
      LIMIT 200
    `, genre ? [genre] : []);

    const titles = rows.map(r =>
      r.title
        .split(/\s*[|｜]\s*/)[0]
        .replace(/\s*\[.*?\]\s*$/, '')
        .replace(/\s*#\S+/g, '')
        .trim()
    ).filter(t => t.length > 0);

    res.json({ success: true, titles });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================
// GET /api/topics/recommendations — 추천 이력 목록
// ============================
router.get('/recommendations', (req, res) => {
  try {
    const { category, limit } = req.query;
    let sql = 'SELECT id, category, group_tag, topic_title, topic_summary, thumb_titles, created_at FROM topic_recommendations';
    const params = [];

    if (category) {
      sql += ' WHERE category = ?';
      params.push(category);
    }

    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(parseInt(limit) || 20);

    const rows = queryAll(sql, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// ============================
// GET /api/topics/recommendations-history — 추천 이력 (topic_recommendations 기준)
// ============================
router.get('/recommendations-history', (req, res) => {
  try {
    const { group_tag, limit = 100 } = req.query;
    let sql = `
      SELECT tr.id, tr.group_tag, tr.topic_title, tr.topic_summary, tr.thumb_titles,
             tr.thumb_title_main, tr.selected_dna_id, tr.story_prompt, tr.story_guideline_id,
             tr.created_at, vd.video_titles as dna_video_titles
      FROM topic_recommendations tr
      LEFT JOIN video_dna vd ON tr.selected_dna_id = vd.id
    `;
    const params = [];

    if (group_tag) {
      sql += ' WHERE tr.group_tag = ?';
      params.push(group_tag);
    }

    sql += ' ORDER BY tr.created_at DESC LIMIT ?';
    params.push(Number(limit));

    const rows = queryAll(sql, params);
    res.json({ outputs: rows });
  } catch (err) {
    console.error('추천 이력 조회 오류:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================
// DELETE /api/topics/recommendations/:recId — 추천 이력 삭제
// ============================
router.delete('/recommendations/:recId', (req, res) => {
  try {
    const recId = Number(req.params.recId);
    const existing = queryOne('SELECT id FROM topic_recommendations WHERE id = ?', [recId]);
    if (!existing) {
      return res.status(404).json({ error: '해당 추천 이력을 찾을 수 없습니다.' });
    }
    runSQL('DELETE FROM topic_recommendations WHERE id = ?', [recId]);
    res.json({ success: true });
  } catch (err) {
    console.error('추천 이력 삭제 오류:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================
// GET /api/topics/recommendations/:id — 추천 상세
// ============================
router.get('/recommendations/:id', (req, res) => {
  try {
    const row = queryOne('SELECT * FROM topic_recommendations WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: '추천 이력을 찾을 수 없습니다.' });
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// ============================
// POST /api/topics/recommend-dna — DNA 추천 (Gemini)
// ============================
router.post('/recommend-dna', async (req, res) => {
  try {
    const { topic_title, topic_summary, thumb_title_main, api_type } = req.body;

    if (!topic_title || !topic_summary) {
      return res.status(400).json({ error: '주제명과 요약은 필수입니다.' });
    }

    // 1) video_dna 전체 조회 후 overall 기준 상위 15개 필터링
    const allDna = queryAll('SELECT id, video_ids, video_titles, channel_names, category, dna_json FROM video_dna', []);
    const parsed = allDna.map(row => {
      try {
        const dna = JSON.parse(row.dna_json);
        return { ...row, dna };
      } catch (e) {
        return null;
      }
    }).filter(Boolean);

    const scored = parsed
      .map(row => ({ ...row, overall: row.dna.scores?.overall || 0 }))
      .sort((a, b) => b.overall - a.overall)
      .slice(0, 15);

    if (scored.length === 0) {
      return res.status(400).json({ error: 'DNA 분석 이력이 없습니다. 먼저 영상 DNA 분석을 진행해주세요.' });
    }

    // 2) 각 DNA에서 추천용 요약 데이터 추출
    const dnaList = scored.map(row => {
      const d = row.dna;
      const ec = d.emotion_dna?.emotion_curve || [];
      const emotionSummary = ec.map(pt => {
        const emotions = { tension: pt.tension, anxiety: pt.anxiety, hope: pt.hope, anger: pt.anger, relief: pt.relief };
        const top = Object.entries(emotions).sort((a, b) => b[1] - a[1])[0];
        return top ? top[0] : '?';
      }).join('→');

      const positives = (d.comment_analysis?.positive || []).slice(0, 3).join(', ');
      const negatives = (d.comment_analysis?.negative || []).slice(0, 2).join(', ');

      const titles = (() => {
        try { return JSON.parse(row.video_titles); } catch (e) { return [row.video_titles]; }
      })();

      return {
        id: row.id,
        video_title: Array.isArray(titles) ? titles[0] : titles,
        overall: d.scores?.overall,
        hook_type: d.hook_dna?.hook_type,
        structure_type: d.structure_dna?.structure_type,
        climax_position: d.structure_dna?.climax_position,
        payoff_type: d.structure_dna?.payoff_type,
        emotion_summary: emotionSummary,
        comment_positive: positives,
        comment_negative: negatives
      };
    });

    // 3) Gemini 프롬프트 구성
    const dnaListText = dnaList.map(d =>
      `DNA #${d.id} - ${d.video_title}\n종합점수: ${d.overall}\n후킹 유형: ${d.hook_type}\n구조: ${d.structure_type}, 클라이맥스 ${d.climax_position}%, 결말 ${d.payoff_type}\n감정 흐름: ${d.emotion_summary}\n댓글 긍정: ${d.comment_positive}\n댓글 부정: ${d.comment_negative}`
    ).join('\n\n');

    const prompt = `당신은 조선 야담 스토리 설계 전문가입니다.
사용자가 새로운 이야기를 기획하고 있습니다.

[이번 이야기]
주제명: ${topic_title}
요약: ${topic_summary}
대표 썸네일 제목: ${thumb_title_main || ''}

[DNA 후보 목록]
${dnaListText}

위 DNA 후보 중에서 이번 이야기의 스토리 설계에 가장 참고가 될 DNA 3개를 추천하세요.

추천 기준 우선순위:
1순위: 구조 유사도 — 후킹 방식, 클라이맥스 위치, 결말 유형이 이번 주제와 맞는지
2순위: 후킹/감정 유사도 — 감정 곡선의 흐름이 이번 주제와 맞는지
3순위: 댓글 반응에서 참고/회피할 포인트가 명확한지. 부정이 적은 DNA가 아니라 이번 설계에서 참고할 수 있는 구체적 포인트가 있는 DNA를 우선
4순위: 종합 성공도

소재가 같다는 이유만으로 추천하지 마세요. 구조와 후킹 방식이 실제로 도움이 되는지를 기준으로 하세요.

추천 구성:
추천 1: 구조가 가장 유사한 DNA (안정형)
추천 2: 부분적으로 참고할 가치가 있는 DNA (참고형)
추천 3: 구조는 다르지만 시도해볼 가치가 있는 DNA (실험형)

반드시 아래 JSON 형식으로만 응답하세요.
{
  "recommendations": [
    {
      "dna_id": DNA의 id 번호,
      "type": "안정형" 또는 "참고형" 또는 "실험형",
      "reason": "추천 이유 (80자 이내)",
      "hook_summary": "후킹 방식 요약 한 줄",
      "emotion_summary": "감정 흐름 요약 한 줄",
      "comment_positive": "댓글 긍정 핵심 한 줄",
      "comment_negative": "댓글 부정 핵심 한 줄"
    }
  ]
}`;

    // 4) Gemini 호출
    const apiType = api_type === 'cloud' ? 'cloud' : null;
    let geminiResult;
    try {
      geminiResult = await callGemini(prompt, { jsonMode: true, maxTokens: 65535 }, apiType);
    } catch (e) {
      return res.status(500).json({ error: 'AI 호출 실패: ' + e.message });
    }

    // 5) 응답 파싱
    let recs;
    try {
      const parsed2 = typeof geminiResult === 'string' ? JSON.parse(geminiResult) : geminiResult;
      recs = parsed2.recommendations;
      if (!Array.isArray(recs) || recs.length === 0) throw new Error('recommendations 없음');
    } catch (e) {
      return res.status(500).json({ error: 'AI 응답 파싱 실패: ' + e.message });
    }

    // 6) 각 추천 DNA의 video_titles 조회 및 overall_score 보강
    const enriched = recs.map(rec => {
      const dnaRow = scored.find(d => d.id === rec.dna_id);
      const titles = dnaRow ? (() => {
        try { return JSON.parse(dnaRow.video_titles); } catch (e) { return [dnaRow.video_titles]; }
      })() : [];
      return {
        dna_id: rec.dna_id,
        type: rec.type,
        reason: rec.reason,
        video_title: Array.isArray(titles) ? titles[0] : titles,
        overall_score: dnaRow?.dna?.scores?.overall,
        hook_type: dnaRow?.dna?.hook_dna?.hook_type,
        hook_summary: rec.hook_summary,
        emotion_summary: rec.emotion_summary,
        comment_positive: rec.comment_positive,
        comment_negative: rec.comment_negative
      };
    });

    res.json({ success: true, recommendations: enriched });
  } catch (e) {
    console.error('[recommend-dna 오류]', e);
    res.status(500).json({ error: e.message });
  }
});

// ============================
// POST /api/topics/generate-story-prompt — 스토리 설계 프롬프트 생성
// ============================
router.post('/generate-story-prompt', (req, res) => {
  try {
    const { selected_dna_id, topic_title, topic_summary, thumb_title_main } = req.body;

    if (!selected_dna_id || !topic_title || !topic_summary) {
      return res.status(400).json({ error: 'selected_dna_id, topic_title, topic_summary는 필수입니다.' });
    }

    // 1) 활성 스토리 설계 지침 조회
    const guideline = queryOne(
      "SELECT * FROM story_guidelines WHERE type='story_design_prompt' AND is_active=1 LIMIT 1",
      []
    );
    if (!guideline) {
      return res.status(400).json({ success: false, error: 'no_guideline', message: '활성화된 스토리 설계 지침이 없습니다.' });
    }

    // 2) 선택된 DNA 조회
    const dnaRow = queryOne('SELECT * FROM video_dna WHERE id = ?', [selected_dna_id]);
    if (!dnaRow) {
      return res.status(400).json({ success: false, error: 'no_dna', message: 'DNA 데이터를 찾을 수 없습니다.' });
    }

    // 4) DNA 파싱 및 필드 검증
    let dna;
    try { dna = JSON.parse(dnaRow.dna_json); } catch (e) {
      return res.status(400).json({ success: false, error: 'incomplete_dna', message: 'DNA 데이터가 불완전합니다.' });
    }
    if (!dna.hook_dna || !dna.structure_dna || !dna.emotion_dna || !dna.pace_dna || !dna.comment_analysis) {
      return res.status(400).json({ success: false, error: 'incomplete_dna', message: 'DNA 데이터가 불완전합니다.' });
    }

    // 5) DNA 문장형 가이드 번역
    const hookGuide = `후킹 설계 참고: ${dna.hook_dna.hook_type}형 시작. 초반에 ${(dna.hook_dna.open_loop || []).length}개의 미해결 질문을 배치. 결과를 암시하되 답은 주지 않는 방식.`;

    const structGuide = `구조 설계 참고: ${dna.structure_dna.structure_type} 구조. 클라이맥스는 전체의 ${dna.structure_dna.climax_position}% 지점. 결말 유형은 ${dna.structure_dna.payoff_type}.`;

    const emotionNames = { tension: '긴장', anxiety: '불안', hope: '희망', anger: '분노', relief: '안도' };
    const ec = dna.emotion_dna.emotion_curve || [];
    const emotionFlow = ec.map(pt => {
      const emotions = { tension: pt.tension, anxiety: pt.anxiety, hope: pt.hope, anger: pt.anger, relief: pt.relief };
      const top = Object.entries(emotions).sort((a, b) => b[1] - a[1])[0];
      return top ? (emotionNames[top[0]] || top[0]) : '?';
    });
    const emotionGuide = `감정 설계 참고: ${emotionFlow.join('→')}.`;

    const paceLabel = dna.pace_dna.short_sentence_ratio >= 0.4 ? '빠른 호흡형' : '중간 호흡형';
    const paceGuide = `페이스 설계 참고: ${paceLabel} 문체. 전개 호흡은 ${dna.pace_dna.short_sentence_ratio >= 0.4 ? '빠른' : '중간'} 편.`;

    const positives = (dna.comment_analysis.positive || []).slice(0, 2).join(', ');
    const negatives = (dna.comment_analysis.negative || []).slice(0, 1).join(', ');
    const commentGuide = `시청자 반응 참고:
긍정- ${positives}.
부정- ${negatives}.`;

    // 6) 고정 구조로 프롬프트 조합
    const dnaGuide = `아래는 성공한 영상의 구조를 역설계한 참고 자료입니다.
이 DNA의 표면을 복제하지 마십시오.
후킹 방식, 감정 곡선, 구조 리듬의 내용을 참고하고,
시청자의 반응은 긍정 부분은 더 강화하고, 부정 부분은 우리 글에서는 없도록 하여 더 우수하고 품질 좋은 글을 설계해주세요.

${hookGuide}
${structGuide}
${emotionGuide}
${paceGuide}
${commentGuide}`;

    const storyPrompt = `[스토리 설계 지침]
${guideline.content}

[주제 데이터]
- 주제명: ${topic_title}
- 요약: ${topic_summary}
- 썸네일 제목: ${thumb_title_main || ''}

[DNA 설계 가이드]
${dnaGuide}`;

    res.json({
      success: true,
      story_prompt: storyPrompt,
      selected_dna_id: Number(selected_dna_id),
      story_guideline_id: guideline.id
    });
  } catch (e) {
    console.error('[generate-story-prompt 오류]', e);
    res.status(500).json({ error: e.message });
  }
});

export default router;
