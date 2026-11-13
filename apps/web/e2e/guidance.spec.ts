import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

async function login(page:Page, subject='alice') {
  await page.goto('/');
  await page.getByRole('button',{name:'Tasklyでログイン'}).click();
  await expect(page.getByRole('heading',{name:'検証用ログイン'})).toBeVisible();
  await page.getByLabel('検証アカウント').selectOption(subject);
  await page.getByRole('button',{name:'検証用アカウントで続ける'}).click();
  await expect(page.getByRole('heading',{name:'新しい可能性を、見つけよう。'})).toBeVisible();
}
const nav=(page:Page,name:string)=>page.getByRole('navigation',{name:'メインナビゲーション'}).getByRole('button',{name,exact:false});

test('OAuth PKCE login, company filters, details and server-persisted bookmarks',async({page})=>{
  await login(page);
  await expect(page.locator('.company-card')).toHaveCount(4);
  await page.getByRole('searchbox').fill('あおば');
  await expect(page.locator('.company-card')).toHaveCount(1);
  await page.getByRole('button',{name:'架空あおばソフトを見学リストに保存',exact:true}).click();
  await expect(page.getByRole('button',{name:'架空あおばソフトを見学リストから削除',exact:true})).toHaveAttribute('aria-pressed','true');
  await page.reload();
  await expect(page.getByRole('button',{name:'架空あおばソフトを見学リストから削除',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'保存した企業',exact:true}).click();
  await expect(page.locator('.company-card')).toHaveCount(1);
  await page.getByRole('button',{name:/架空あおばソフト 情報処理 ブース/}).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('heading',{name:'架空あおばソフト',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'詳細を閉じる'}).click();
  await page.getByRole('button',{name:'保存した企業',exact:true}).click();
  await page.getByRole('button',{name:/午後の部2/}).click();
  await expect(page.locator('.company-card')).toHaveCount(2);
  await page.getByLabel('業種で絞り込む').selectOption('建設');
  await expect(page.locator('.company-card')).toHaveCount(1);
  await page.getByRole('searchbox').fill('存在しないキーワード');
  await expect(page.getByRole('heading',{name:'条件に合う企業が見つかりません'})).toBeVisible();
  await page.getByRole('button',{name:'条件をリセット'}).click();
  await expect(page.locator('.company-card')).toHaveCount(4);
});

test('Schedule, student assignment lookup, private maps, zoom and original PDF',async({page})=>{
  await login(page);
  await nav(page,'スケジュール').click();
  await expect(page.locator('.timeline-item')).toHaveCount(8);
  await page.getByLabel('スケジュールの学年').selectOption('3');
  await expect(page.locator('.term-badge.required')).toHaveCount(4);
  await nav(page,'自分の見学リスト').click();
  await page.getByLabel('学科',{exact:true}).selectOption('架空工学科');
  await page.getByLabel('学年',{exact:true}).selectOption('4');
  await page.getByRole('spinbutton',{name:'出席番号'}).fill('7');
  await page.getByRole('button',{name:'確認する',exact:true}).click();
  await expect(page.locator('.assignment-visits button')).toHaveCount(4);
  await page.locator('.assignment-visits button').first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button',{name:/マップを確認/}).click();
  await expect(page.getByRole('img',{name:'検証1階マップ'})).toBeVisible();
  await page.getByRole('button',{name:'マップを拡大',exact:true}).click();
  await expect(page.getByRole('button',{name:'拡大率を100パーセントに戻す'})).toHaveText('125%');
  await page.getByRole('button',{name:'マップを縮小',exact:true}).click();
  await page.getByRole('button',{name:'検証2階マップ',exact:true}).click();
  await expect(page.getByRole('img',{name:'検証2階マップ'})).toBeVisible();
  const responsePromise=page.waitForResponse(r=>r.url().endsWith('/api/documents/guide'));
  const popupPromise=page.waitForEvent('popup');
  await page.getByRole('button',{name:/検証用ガイドPDF/}).click();
  const [response,popup]=await Promise.all([responsePromise,popupPromise]);
  expect(response.status()).toBe(200); expect(response.headers()['content-type']).toBe('application/pdf'); await popup.close();
  await nav(page,'自分の見学リスト').click();
  await page.getByLabel('学科',{exact:true}).selectOption('架空工学科');
  await page.getByRole('spinbutton',{name:'出席番号'}).fill('99');
  await page.getByRole('button',{name:'確認する',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('指定企業の登録が見つかりません');
});

test('Saved companies are isolated by identity; logout closes protected resources',async({page,request})=>{
  await login(page,'alice');
  await expect(page.getByRole('button',{name:'架空あおばソフトを見学リストから削除',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'ログアウト',exact:true}).click();
  await expect(page.getByRole('button',{name:'Tasklyでログイン'})).toBeVisible();
  const protectedResponse=await request.get('http://127.0.0.1:3371/api/documents/floor-a');
  expect(protectedResponse.status()).toBe(401);
  await login(page,'bob');
  await page.getByRole('button',{name:'保存した企業',exact:true}).click();
  await expect(page.getByRole('heading',{name:'条件に合う企業が見つかりません'})).toBeVisible();
  await page.getByRole('button',{name:'条件をリセット'}).click();
  await page.getByRole('button',{name:'架空あおばソフトを見学リストに保存',exact:true}).click();
  await expect(page.getByRole('button',{name:'架空あおばソフトを見学リストから削除',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'架空あおばソフトを見学リストから削除',exact:true}).click();
  await expect(page.getByRole('button',{name:'架空あおばソフトを見学リストに保存',exact:true})).toBeVisible();
});

test('Identity outage fails closed, recovers, then revoked login offers reauthentication',async({page,request})=>{
  await login(page,'alice');
  await request.post('http://127.0.0.1:3372/__test/outage?enabled=1');
  await page.reload();
  await expect(page.getByRole('button',{name:'もう一度接続する'})).toBeVisible();
  await expect(page.locator('.company-card')).toHaveCount(0);
  await request.post('http://127.0.0.1:3372/__test/outage?enabled=0');
  await page.getByRole('button',{name:'もう一度接続する'}).click();
  await expect(page.locator('.company-card')).toHaveCount(4);
  await request.post('http://127.0.0.1:3372/__test/revoke?subject=alice');
  await page.getByRole('button',{name:'架空いろは機械を見学リストに保存',exact:true}).click();
  await expect(page.getByRole('button',{name:'Tasklyでログイン'})).toBeVisible();
  await expect(page.locator('.company-card')).toHaveCount(0);
  await login(page,'alice');
  await expect(page.locator('.company-card')).toHaveCount(4);
});

test('Mobile navigation keeps maps and saved companies usable',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await login(page,'bob');
  const mobile=page.getByRole('navigation',{name:'モバイルナビゲーション'});
  await mobile.getByRole('button',{name:'マップ',exact:true}).click();
  await expect(page.getByRole('img',{name:'検証1階マップ'})).toBeVisible();
  await mobile.getByRole('button',{name:'見学リスト',exact:true}).click();
  await expect(page.getByRole('heading',{name:'自分の指定企業を確認'})).toBeVisible();
  await expect(page.locator('body')).toHaveJSProperty('scrollWidth',390);
});
