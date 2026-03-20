// Rebuild video_spike_rankings table for one or all genres
import { getDB } from '../db.js';

/**
 * Rebuild video_spike_rankings for a given genre, or all genres if genre is null/undefined.
 * @param {string|null} genre - e.g. '야담', '경제', or null for all
 * @returns {number} total inserted rows
 */
export function rebuildSpikeRankings(genre = null) {
    const db = getDB();
    const t0 = Date.now();

    // Ensure table exists
    db.exec(`
      CREATE TABLE IF NOT EXISTS video_spike_rankings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        video_id INTEGER NOT NULL,
        category_id INTEGER NOT NULL,
        category_name TEXT NOT NULL,
        genre TEXT NOT NULL DEFAULT '',
        spike_ratio REAL NOT NULL DEFAULT 0,
        channel_avg_views REAL NOT NULL DEFAULT 0,
        channel_avg_multiple REAL NOT NULL DEFAULT 0,
        view_count INTEGER NOT NULL DEFAULT 0,
        subscriber_count INTEGER NOT NULL DEFAULT 0,
        channel_id INTEGER NOT NULL,
        channel_name TEXT,
        video_title TEXT,
        video_id_youtube TEXT,
        thumbnail_url TEXT,
        duration_seconds INTEGER DEFAULT 0,
        like_count INTEGER DEFAULT 0,
        published_at TEXT,
        rank_in_category INTEGER DEFAULT 0,
        is_spike BOOLEAN NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now', 'localtime')),
        updated_at TEXT DEFAULT (datetime('now', 'localtime')),
        UNIQUE(video_id, category_id)
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_spike_genre_cat ON video_spike_rankings(genre, category_name)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_spike_category_rank ON video_spike_rankings(category_id, rank_in_category)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_spike_is_spike ON video_spike_rankings(is_spike)`);

    // Determine genres to process
    let genres;
    if (genre) {
        genres = [genre];
    } else {
        const rows = db.prepare(
            `SELECT DISTINCT group_tag FROM channels WHERE group_tag IS NOT NULL AND group_tag != ''`
        ).all();
        genres = rows.map(r => r.group_tag);
    }

    let totalCount = 0;

    const VALID_CATEGORIES = [
        '풍속/일상', '복수극', '로맨스',
        '괴담/미스터리', '범죄/옥사', '사기/기만', '전쟁/영웅',
        '주식/투자', '부동산', '재테크/저축',
        '경제 전망/시황', '세금/정책', '창업/사업', '노후/연금'
    ];

    for (const g of genres) {
        // Get category names for this genre from DB
        const cats = db.prepare(`SELECT DISTINCT name FROM categories WHERE genre = ?`).all(g);
        if (cats.length === 0) continue;
        const catNames = cats.map(c => c.name).filter(name => VALID_CATEGORIES.includes(name));
        if (catNames.length === 0) continue;
        const placeholders = catNames.map(() => '?').join(',');

        // Delete existing records for this genre
        db.prepare(`DELETE FROM video_spike_rankings WHERE genre = ?`).run(g);

        // Insert fresh data
        const insertSQL = `
          INSERT OR REPLACE INTO video_spike_rankings
          (video_id, category_id, category_name, genre,
           spike_ratio, channel_avg_views, channel_avg_multiple,
           view_count, subscriber_count, channel_id, channel_name,
           video_title, video_id_youtube, thumbnail_url,
           duration_seconds, like_count, published_at,
           is_spike, rank_in_category)
          SELECT
            sub.video_id,
            sub.category_id,
            sub.category_name,
            ? as genre,
            sub.spike_ratio,
            sub.channel_avg_views,
            0 as channel_avg_multiple,
            sub.view_count,
            sub.subscriber_count,
            sub.channel_id,
            sub.channel_name,
            sub.video_title,
            sub.video_id_youtube,
            sub.thumbnail_url,
            sub.duration_seconds,
            sub.like_count,
            sub.published_at,
            CASE WHEN sub.spike_ratio >= 50
              THEN 1 ELSE 0 END as is_spike,
            0 as rank_in_category
          FROM (
            SELECT
              v.id as video_id,
              cat.id as category_id,
              cat.name as category_name,
              CASE WHEN c.subscriber_count > 0 AND CAST(julianday('now') - julianday(v.published_at) AS INTEGER) >= 3
                THEN ROUND(
                  (CAST(v.view_count AS REAL) / CAST(julianday('now') - julianday(v.published_at) AS INTEGER))
                  / c.subscriber_count * 100
                , 2)
                ELSE 0 END as spike_ratio,
              COALESCE(cavg.avg_views, 0) as channel_avg_views,
              v.view_count,
              c.subscriber_count,
              c.id as channel_id,
              c.name as channel_name,
              v.title as video_title,
              v.video_id as video_id_youtube,
              v.thumbnail_url,
              v.duration_seconds,
              v.like_count,
              v.published_at
            FROM videos v
            JOIN channels c ON v.channel_id = c.id
            JOIN video_categories vc ON v.id = vc.video_id
            JOIN categories cat ON vc.category_id = cat.id
            LEFT JOIN (
              SELECT channel_id, ROUND(AVG(view_count)) as avg_views
              FROM videos
              WHERE view_count > 0
              GROUP BY channel_id
            ) cavg ON c.id = cavg.channel_id
            WHERE c.group_tag = ?
              AND v.view_count >= 5000
              AND c.subscriber_count > 0
              AND v.duration_seconds > 300
              AND v.published_at >= date('now', '-3 months')
              AND CAST(julianday('now') - julianday(v.published_at) AS INTEGER) >= 3
              AND cat.genre = ?
              AND cat.name IN (${placeholders})
              AND (
                CASE
                  WHEN (SELECT sub_type_mode FROM category_settings
                        WHERE category_name = c.group_tag) = 'dual'
                  THEN c.sub_type = '만화'
                  ELSE 1
                END
              )
          ) sub
        `;

        const result = db.prepare(insertSQL).run(g, g, g, ...catNames);
        totalCount += result.changes;

        // Update rank_in_category
        db.prepare(`
          UPDATE video_spike_rankings SET rank_in_category = (
            SELECT cnt FROM (
              SELECT id,
                ROW_NUMBER() OVER (
                  PARTITION BY category_id
                  ORDER BY spike_ratio DESC, view_count DESC
                ) as cnt
              FROM video_spike_rankings
              WHERE genre = ?
            ) ranked
            WHERE ranked.id = video_spike_rankings.id
          )
          WHERE genre = ?
        `).run(g, g);
    }

    console.log('[rebuild] 소요:', Date.now() - t0, 'ms, 건수:', totalCount);
    return totalCount;
}

/**
 * TOP50 재계산 전후 순위 변동 분석
 * @param {object} db - better-sqlite3 DB 인스턴스
 * @param {string} genre - 장르 (e.g. '야담', '경제')
 * @returns {{ totalChanges, newEntries, rankUps, dropOuts, changes[] }}
 */
export function analyzeRankingChanges(db, genre) {
    // 1. rebuild 전 소재별 TOP5 스냅샷
    const beforeRankings = db.prepare(`
        SELECT video_id, rank_in_category, category_name,
               video_title, view_count, channel_name, thumbnail_url,
               video_id_youtube, spike_ratio, subscriber_count, published_at
        FROM video_spike_rankings
        WHERE genre = ? AND is_spike = 1 AND rank_in_category <= 5
        ORDER BY category_name, rank_in_category ASC
    `).all(genre);

    const beforeMap = new Map();
    for (const r of beforeRankings) {
        beforeMap.set(r.video_id, {
            rank: r.rank_in_category,
            category: r.category_name,
            title: r.video_title,
            views: r.view_count,
            channel: r.channel_name,
            thumbnail: r.thumbnail_url,
            videoIdYoutube: r.video_id_youtube,
            spikeRatio: r.spike_ratio,
            subscriberCount: r.subscriber_count,
            publishedAt: r.published_at
        });
    }

    // 2. TOP50 재계산
    rebuildSpikeRankings(genre);

    // 3. rebuild 후 소재별 TOP5 스냅샷
    const afterRankings = db.prepare(`
        SELECT video_id, rank_in_category, category_name,
               video_title, view_count, channel_name, thumbnail_url,
               video_id_youtube, spike_ratio, subscriber_count, published_at
        FROM video_spike_rankings
        WHERE genre = ? AND is_spike = 1 AND rank_in_category <= 5
        ORDER BY category_name, rank_in_category ASC
    `).all(genre);

    // 4. 변동 분류
    const changes = [];

    for (const after of afterRankings) {
        const before = beforeMap.get(after.video_id);
        if (!before) {
            changes.push({
                type: 'new',
                title: after.video_title,
                channel: after.channel_name,
                category: after.category_name,
                newRank: after.rank_in_category,
                oldRank: null,
                views: after.view_count,
                oldViews: 0,
                thumbnail: after.thumbnail_url,
                videoIdYoutube: after.video_id_youtube,
                spikeRatio: after.spike_ratio,
                subscriberCount: after.subscriber_count,
                publishedAt: after.published_at,
                label: `NEW → ${after.category_name} ${after.rank_in_category}위`
            });
        } else if (after.rank_in_category < before.rank) {
            changes.push({
                type: 'up',
                title: after.video_title,
                channel: after.channel_name,
                category: after.category_name,
                newRank: after.rank_in_category,
                oldRank: before.rank,
                views: after.view_count,
                oldViews: before.views,
                thumbnail: after.thumbnail_url,
                videoIdYoutube: after.video_id_youtube,
                spikeRatio: after.spike_ratio,
                oldSpikeRatio: before.spikeRatio,
                subscriberCount: after.subscriber_count,
                publishedAt: after.published_at,
                label: `${before.rank}위 → ${after.rank_in_category}위`
            });
        } else if (after.rank_in_category > before.rank) {
            changes.push({
                type: 'down',
                title: after.video_title,
                channel: after.channel_name,
                category: after.category_name,
                newRank: after.rank_in_category,
                oldRank: before.rank,
                views: after.view_count,
                oldViews: before.views,
                thumbnail: after.thumbnail_url,
                videoIdYoutube: after.video_id_youtube,
                spikeRatio: after.spike_ratio,
                oldSpikeRatio: before.spikeRatio,
                subscriberCount: after.subscriber_count,
                publishedAt: after.published_at,
                label: `${before.rank}위 → ${after.rank_in_category}위`
            });
        }
    }

    // 탈락
    const afterIds = new Set(afterRankings.map(r => r.video_id));
    for (const [vid, info] of beforeMap) {
        if (!afterIds.has(vid)) {
            changes.push({
                type: 'out',
                title: info.title,
                channel: info.channel,
                category: info.category,
                newRank: null,
                oldRank: info.rank,
                views: info.views,
                oldViews: info.views,
                thumbnail: info.thumbnail,
                videoIdYoutube: info.videoIdYoutube,
                spikeRatio: info.spikeRatio,
                subscriberCount: info.subscriberCount,
                publishedAt: info.publishedAt,
                label: `${info.category} ${info.rank}위 → 탈락`
            });
        }
    }

    const priority = { new: 0, up: 1, down: 2, out: 3 };
    changes.sort((a, b) => {
        if (priority[a.type] !== priority[b.type]) return priority[a.type] - priority[b.type];
        return (a.newRank || 999) - (b.newRank || 999);
    });

    // 소재별 현재 TOP5
    const currentTop5 = {};
    for (const r of afterRankings) {
        if (!currentTop5[r.category_name]) currentTop5[r.category_name] = [];
        if (currentTop5[r.category_name].length < 5) {
            currentTop5[r.category_name].push({
                rank: r.rank_in_category,
                title: r.video_title,
                channel: r.channel_name,
                views: r.view_count,
                thumbnail: r.thumbnail_url,
                videoIdYoutube: r.video_id_youtube,
                spikeRatio: r.spike_ratio,
                subscriberCount: r.subscriber_count,
                publishedAt: r.published_at
            });
        }
    }

    const newEntries = changes.filter(c => c.type === 'new').length;
    const rankUps = changes.filter(c => c.type === 'up').length;
    const rankDowns = changes.filter(c => c.type === 'down').length;
    const dropOuts = changes.filter(c => c.type === 'out').length;

    return {
        totalChanges: newEntries + rankUps + rankDowns + dropOuts,
        newEntries,
        rankUps,
        rankDowns,
        dropOuts,
        changes,
        currentTop5
    };
}
