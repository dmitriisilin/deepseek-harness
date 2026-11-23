/** Verify the red fork using a cold recorded chat and role-addressable browser controls. */
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { fixtureUserPrompts, launchWebScaffold, seedSession } from './scaffold.ts'
import { connectFreshWorkspace, revealNavigationDrawer } from './support.ts'

const fixture = fileURLToPath(new URL('../../../snapshots/web/fresh-round-trip/session.v3.jsonl', import.meta.url))
const output = process.env.AI_CONTROL_SCREENSHOTS

it.runIf(process.env.DSH_WEB_BRAND === 'ai-control-red')('shows the mobile chat and its view menu from a cold stored session', async () => {
  const scaffold = await launchWebScaffold()
  onTestFinished(() => scaffold.close())
  const id = await seedSession(scaffold, await readFile(fixture, 'utf8'), 'ai-control-fixture-chat')
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  if (output) await mkdir(output, { recursive: true })
  for (const [width, height] of [[360, 780], [412, 915], [1366, 900]] as const) {
    for (const colorScheme of ['light', 'dark'] as const) {
      const context = await browser.newContext({
        viewport: { width, height }, colorScheme, locale: 'en-US', isMobile: width < 600, hasTouch: width < 600,
      })
      try {
        const page = await context.newPage()
        await page.goto(scaffold.authenticatedUrl)
        expect(await page.locator('html').getAttribute('data-ai-control')).toBe('red')
        await revealNavigationDrawer(page, 'en')
        const row = page.locator(`[data-row-key="session:${id}"]`).first()
        if (!(await row.isVisible())) {
          const ungrouped = page.getByRole('treeitem', { name: /Ungrouped/ })
          if (await ungrouped.isVisible()) await ungrouped.click()
        }
        if (output) await page.screenshot({ path: join(output, `list-${width}-${colorScheme}.png`), animations: 'disabled' })
        await row.click()
        const menu = page.getByRole('button', { name: width < 600 ? 'More actions' : 'More conversation views', exact: true })
        await menu.waitFor({ timeout: 15_000 })
        const cost = page.locator('[data-composer-stat="usage"]').getByRole('button')
        await cost.waitFor()
        expect(await cost.innerText()).toMatch(/^≈\s*\$0\./)
        if (width === 360 && colorScheme === 'light') {
          await cost.click()
          await page.getByText('Estimated cost', { exact: true }).waitFor()
          await cost.click()
        }
        if (output) await page.screenshot({ path: join(output, `chat-${width}-${colorScheme}.png`), animations: 'disabled' })
        if (width < 600) {
          const answer = page.getByText('DONE', { exact: true })
          await answer.waitFor()
          expect(await answer.evaluate(node => getComputedStyle(node).fontSize)).toBe('17px')
          expect(await answer.evaluate(node => parseFloat(getComputedStyle(node).lineHeight))).toBeCloseTo(25, 0)
          expect((await page.locator('[data-composer-input]').boundingBox())!.height).toBeLessThanOrEqual(40)
          expect(await page.locator('[data-conversation-tabs]').isVisible()).toBe(false)
          await menu.click()
          const trajectory = page.getByText('Trajectory', { exact: true })
          await trajectory.waitFor()
          if (output) await page.screenshot({ path: join(output, `views-${width}-${colorScheme}.png`), animations: 'disabled' })
          await trajectory.click()
          await page.locator('[data-trajectory-scroll]').waitFor()
          const chatAction = page.getByRole('menuitem', { name: 'Chat', exact: true })
          if (!(await chatAction.isVisible())) await menu.click()
          await chatAction.click({ timeout: 10_000 })
          await page.locator('[data-trajectory-scroll]').waitFor({ state: 'hidden' })
          const replyMenu = page.locator('details[class*="aiControlMessageMenu"]').last()
          await replyMenu.locator('summary').click()
          await context.grantPermissions(['clipboard-read', 'clipboard-write'])
          await replyMenu.getByRole('button', { name: 'Copy', exact: true }).click()
          await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('DONE')
          await replyMenu.locator('summary').click()
          await page.getByRole('button', { name: /Select model/ }).click()
          const approval = page.locator('summary[aria-label^="Access mode"]')
          await approval.waitFor()
          const modelMenu = page.getByRole('menu').filter({ has: approval })
          expect(await modelMenu.getByRole('menuitem').count()).toBe(2)
          expect(await modelMenu.locator('summary').count()).toBe(1)
          expect(await approval.innerText()).toMatch(/^Access\s+Workspace$/)
          const menuBounds = (await modelMenu.boundingBox())!
          expect(menuBounds.x).toBeCloseTo(12, 0)
          expect(menuBounds.width).toBeCloseTo(width - 24, 0)
          for (const row of await modelMenu.getByRole('menuitem').all()) {
            expect((await row.boundingBox())?.height).toBe((await approval.boundingBox())?.height)
          }
          await approval.click()
          await modelMenu.getByRole('button', { name: /Workspace Write/ }).waitFor()
          await approval.click()
          if (output) await page.screenshot({ path: join(output, `model-${width}-${colorScheme}.png`), animations: 'disabled' })
          if (width === 360 && colorScheme === 'light') {
            await page.reload()
            await page.locator('[data-composer-input][contenteditable="true"][data-placeholder="Type your message"]').waitFor()
            expect(await page.getByText('DONE', { exact: true }).isVisible()).toBe(false)
          }
        }
      } finally {
        await context.close()
      }
    }
  }
})


it.runIf(process.env.DSH_WEB_BRAND === 'ai-control-red')('creates a project, a project session and a standalone chat from the sidebar', async () => {
  const scaffold = await launchWebScaffold()
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const recent = await seedSession(scaffold, await readFile(fixture, 'utf8'), 'ai-control-project-history')
  await scaffold.ctx.workspaceRegistry.pinSession(recent)
  const page = await browser.newPage({ viewport: { width: 412, height: 915 }, locale: 'en-US', isMobile: true, hasTouch: true })
  await page.goto(scaffold.authenticatedUrl)
  await connectFreshWorkspace(page, scaffold.workspaceCwd, 'AI Control project')
  const project = scaffold.ctx.workspaceRegistry.list().find(item => item.path.endsWith('/AI Control project'))
  expect(project).toBeDefined()
  await revealNavigationDrawer(page, 'en')
  const createInProject = page.waitForResponse('**/api/session/create')
  await page.getByRole('button', { name: 'New session in AI Control project', exact: true }).click()
  const created = await createInProject
  expect(created.request().postDataJSON()).toHaveProperty('payload.args.request.workspaceId', project!.id)
  await revealNavigationDrawer(page, 'en')
  await page.getByRole('button', { name: 'Pin project', exact: true }).click()
  await page.getByRole('region', { name: 'Pinned', exact: true }).getByRole('button', { name: 'AI Control project' }).waitFor()
  const projects = page.getByRole('button', { name: 'Projects', exact: true })
  await projects.click()
  expect(await projects.getAttribute('aria-expanded')).toBe('false')
  await page.getByRole('region', { name: 'Pinned', exact: true }).getByRole('button', { name: 'AI Control project' }).click()
  expect(await projects.getAttribute('aria-expanded')).toBe('true')
  if (output) await page.screenshot({ path: join(output, 'list-projects-412-light.png'), animations: 'disabled' })
  const createQuickChat = page.waitForResponse('**/api/session/create')
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  const quickChat = await createQuickChat
  const body = await quickChat.json()
  expect(body.result.ok).toBe(true)
  expect(quickChat.request().postDataJSON()).not.toHaveProperty('payload.args.request.workspaceId')
  expect(project!.sessionIds).not.toContain(body.result.value.sessionId)
  await page.locator('[data-composer-input][contenteditable=true]').waitFor()

  await revealNavigationDrawer(page, 'en')
  const pinnedHistory = page.getByRole('region', { name: 'Pinned', exact: true })
    .locator(`[data-row-key="session:${recent}"]`)
  await pinnedHistory.getByRole('button', { name: /session actions/i }).click()
  const sessionActions = page.getByRole('menu').filter({ has: page.getByRole('menuitem', { name: 'Archive session', exact: true }) })
  await sessionActions.waitFor()
  expect(await sessionActions.getByRole('menuitem').allTextContents()).toEqual(['Unpin session', 'Rename', 'Archive session'])
  await sessionActions.getByRole('menuitem', { name: 'Archive session', exact: true }).click()
  await expect.poll(() => scaffold.ctx.workspaceRegistry.archivedSessionIds.includes(recent)).toBe(true)
  await pinnedHistory.waitFor({ state: 'hidden' })
})

it.runIf(process.env.DSH_WEB_BRAND === 'ai-control-red')('keeps a legacy default Workspace out of projects after reopening', async () => {
  const scaffold = await launchWebScaffold({ firstUse: true })
  onTestFinished(() => scaffold.close())
  const legacy = await scaffold.ctx.workspaceRegistry.initializeDefault(async () => scaffold.workspaceCwd)
  expect(legacy).toBeDefined()
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 360, height: 780 }, locale: 'en-US', isMobile: true, hasTouch: true })
  await page.goto(scaffold.authenticatedUrl)
  await page.locator('[data-composer-input][contenteditable=true]').waitFor()
  await page.reload()
  await page.locator('[data-composer-input][contenteditable=true]').waitFor()
  await revealNavigationDrawer(page, 'en')
  expect(await page.getByRole('button', { name: 'Projects', exact: true }).isVisible()).toBe(true)
  expect(await page.getByRole('button', { name: /New session in / }).count()).toBe(0)
  expect(scaffold.ctx.workspaceRegistry.get(legacy!.id)).toBeDefined()
})

it.runIf(process.env.DSH_WEB_BRAND === 'ai-control-red')('opens without a Workspace and fits the Russian project controls after explicit selection', async () => {
  const scaffold = await launchWebScaffold()
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd, 'Рабочая область по умолчанию')
  const page = await browser.newPage({ viewport: { width: 360, height: 780 }, locale: 'ru-RU', isMobile: true, hasTouch: true })
  const initialCreate = page.waitForResponse('**/api/session/create')
  const openChat = Promise.withResolvers<undefined>()
  await page.route('**/api/session/create', async (route) => {
    await openChat.promise
    await route.continue()
  }, { times: 1 })
  try {
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'domcontentloaded' })
    await page.locator('[data-composer-input][data-placeholder="Напишите сообщение"]').waitFor()
    expect(await page.getByText('Выберите рабочее пространство', { exact: true }).isVisible()).toBe(false)
  } finally {
    openChat.resolve(undefined)
  }
  const created = await initialCreate
  const initial = await created.json()
  expect(initial.result.ok).toBe(true)
  expect(created.request().postDataJSON()).not.toHaveProperty('payload.args.request.workspaceId')
  expect(workspace.sessionIds).not.toContain(initial.result.value.sessionId)
  const input = page.locator('[data-composer-input][contenteditable="true"][data-placeholder="Напишите сообщение"]')
  await input.waitFor()
  expect((await input.boundingBox())?.height).toBeGreaterThanOrEqual(84)
  expect(await page.getByText('Стандартный режим', { exact: true }).isVisible()).toBe(false)
  expect(await page.locator('[data-sidebar-right-expand]').isVisible()).toBe(false)
  expect((await page.locator('[data-sidebar-opener] svg').boundingBox())?.width).toBeGreaterThanOrEqual(28)
  const iconUrls = await page.evaluate(async () => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]')!
    const manifest = await (await fetch(link.href)).json() as { icons: { src: string }[] }
    return manifest.icons.map(icon => icon.src)
  })
  expect(iconUrls).toContain('icon-ai-control-v3-maskable-512.png')
  const add = page.getByRole('button', { name: 'Добавить вложение' })
  for (const [label, accept, capture, multiple] of [
    ['Камера', 'image/*', 'environment', false],
    ['Фото', 'image/*', null, true],
    ['Файлы', null, null, true],
  ] as const) {
    await add.click()
    const menu = page.getByRole('menu').filter({ has: page.getByRole('menuitem', { name: label, exact: true }) })
    expect(await menu.getByRole('menuitem').allTextContents()).toEqual(['Камера', 'Фото', 'Файлы'])
    if (output && label === 'Камера') {
      await page.screenshot({ path: join(output, 'attachments-360-ru.png'), animations: 'disabled' })
    }
    expect(await input.evaluate(node => node === document.activeElement)).toBe(false)
    const [picker] = await Promise.all([
      page.waitForEvent('filechooser'),
      menu.getByRole('menuitem', { name: label, exact: true }).click(),
    ])
    expect(await picker.element().getAttribute('accept')).toBe(accept)
    expect(await picker.element().getAttribute('capture')).toBe(capture)
    expect(picker.isMultiple()).toBe(multiple)
    if (label === 'Файлы') {
      await picker.setFiles({ name: 'check.txt', mimeType: 'text/plain', buffer: Buffer.from('AI Control') })
      await page.getByTitle('check.txt').waitFor()
    }
  }
  if (output) await page.screenshot({ path: join(output, 'ai-control-mobile-home-360-ru.png'), animations: 'disabled' })

  await page.locator('[data-sidebar-opener]').click()
  await page.getByRole('button', { name: 'Новая сессия в Рабочая область по умолчанию', exact: true }).click()
  const workspaceLabel = page.locator('[data-composer-seat]').getByText('Рабочая область по умолчанию', { exact: true })
  await workspaceLabel.waitFor()
  expect(await page.getByText('Стандартный режим', { exact: true }).isVisible()).toBe(false)
  expect(await workspaceLabel.evaluate(label => label.scrollWidth <= label.clientWidth)).toBe(true)
  if (output) await page.screenshot({ path: join(output, 'ai-control-mobile-project-360-ru.png'), animations: 'disabled' })
})

it.runIf(process.env.DSH_WEB_BRAND === 'ai-control-red')('keeps live work in a single expandable row', async () => {
  const scaffold = await launchWebScaffold({ replayFixture: fixture, paceMs: 300 })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await browser.newPage({
    viewport: { width: 360, height: 780 }, locale: 'en-US', isMobile: true, hasTouch: true,
  })
  await page.goto(scaffold.authenticatedUrl)
  await connectFreshWorkspace(page, scaffold.workspaceCwd)
  const [prompt] = fixtureUserPrompts(await readFile(fixture, 'utf8'))
  await page.locator('[data-composer-input]').fill(prompt!)
  await page.getByRole('button', { name: 'Send message', exact: true }).click()

  const progress = page.locator('[data-turn-process-running]')
  await progress.waitFor()
  expect(await progress.count()).toBe(1)
  await expect.poll(() => progress.getAttribute('aria-expanded')).toBe('false')
  expect(await page.locator('[data-chat-running]').isVisible()).toBe(false)
  const bounds = (await progress.boundingBox())!
  expect(bounds.x).toBeGreaterThan(0)
  expect(bounds.x + bounds.width).toBeLessThan(360)
  if (output) await page.screenshot({ path: join(output, 'progress-360-light.png'), animations: 'disabled' })
  await progress.click()
  expect(await progress.getAttribute('aria-expanded')).toBe('true')
  await page.getByText('DONE', { exact: true }).waitFor()
  await progress.waitFor({ state: 'detached' })
})
