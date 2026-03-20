import { initDB, runSQL } from './server/db.js';

async function seed() {
    await initDB();

    const categories = [
        // X축: 투자자산
        { group: '투자자산', name: '주식', color: '#3b82f6', order: 1 },
        { group: '투자자산', name: '부동산', color: '#10b981', order: 2 },
        { group: '투자자산', name: '가상자산', color: '#f59e0b', order: 3 },
        { group: '투자자산', name: '금/원자재', color: '#d97706', order: 4 },
        { group: '투자자산', name: '채권', color: '#6366f1', order: 5 },

        // Y축: 경제주체
        { group: '경제주체', name: '개인/가계', color: '#ec4899', order: 1 },
        { group: '경제주체', name: '기업', color: '#8b5cf6', order: 2 },
        { group: '경제주체', name: '정부', color: '#64748b', order: 3 },
        { group: '경제주체', name: '글로벌', color: '#06b6d4', order: 4 },

        // Y축: 시장상황
        { group: '시장상황', name: '호황/상승', color: '#ef4444', order: 1 },
        { group: '시장상황', name: '불황/하락', color: '#3b82f6', order: 2 },
        { group: '시장상황', name: '경제위기', color: '#450a0a', order: 3 },
        { group: '시장상황', name: '통화정책', color: '#7c5cff', order: 4 }
    ];

    console.log('Inserting economy categories...');
    for (const c of categories) {
        try {
            runSQL('INSERT OR IGNORE INTO categories (group_name, name, color, sort_order) VALUES (?, ?, ?, ?)',
                [c.group, c.name, c.color, c.order]);
            console.log(`- Added: ${c.group} > ${c.name}`);
        } catch (e) {
            console.error(`- Failed: ${c.group} > ${c.name}`, e.message);
        }
    }
    console.log('✅ Done.');
}

seed();
