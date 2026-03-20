import { initDB, runSQL, queryAll } from './server/db.js';

async function seed() {
    await initDB();

    // 1. Remove old economy categories
    console.log('Cleaning old economy categories...');
    const oldGroups = ['투자자산', '경제주체', '시장상황'];
    for (const group of oldGroups) {
        runSQL('DELETE FROM categories WHERE group_name = ?', [group]);
    }

    // 2. Insert new Economy Main Categories (1-12)
    const mainCategories = [
        { name: '최신 경제 이슈', order: 1 },
        { name: '금리 / 금융 환경', order: 2 },
        { name: '부동산 / 주거', order: 3 },
        { name: '주식 / 투자 시장', order: 4 },
        { name: '코인 / 디지털 자산', order: 5 },
        { name: '정부 정책 / 세금', order: 6 },
        { name: '생활경제 / 물가', order: 7 },
        { name: '노후 / 연금 / 자산관리', order: 8 },
        { name: '글로벌 경제 / 국제 이슈', order: 9 },
        { name: '산업 / 기술 변화', order: 10 },
        { name: '개인 재테크 / 돈 관리', order: 11 },
        { name: '경제 인물 / 시장 발언', order: 12 }
    ];

    const subCategories = [
        '금리 발표 / 금융 정책',
        '주식 시장 급등 / 급락',
        '코인 급등 / 급락',
        '정부 정책 발표',
        '경제 위기 신호',
        '부동산 정책 변화',
        '글로벌 경제 뉴스',
        '환율 급변',
        '산업 대기업 이슈',
        '경제 인물 발언'
    ];

    console.log('Inserting new Economy Main categories...');
    for (const c of mainCategories) {
        runSQL('INSERT OR IGNORE INTO categories (group_name, name, color, sort_order) VALUES (?, ?, ?, ?)',
            ['경제(메인)', c.name, '#3b82f6', c.order]);
    }

    console.log('Inserting Economy Sub categories...');
    for (let i = 0; i < subCategories.length; i++) {
        runSQL('INSERT OR IGNORE INTO categories (group_name, name, color, sort_order) VALUES (?, ?, ?, ?)',
            ['경제(최신분류)', subCategories[i], '#60a5fa', i + 1]);
    }

    console.log('✅ Economy categories seeding done.');
}

seed();
