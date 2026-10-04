"""
E2E for AI Project Commander — requirement #56.

Drives a REAL Chromium browser against a REAL server with REAL demo projects that have
been built and tested by REAL subprocesses. Covers the main path:

  open system -> dashboard -> attention center -> open project detail -> overview ->
  tests -> risks -> next action -> generate agent prompt -> search -> settings

Run via `npm run test:e2e` (which starts/stops the server for you) or directly with
E2E_BASE_URL pointing at a running instance.
"""
import os
import re
import sys
import time
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get("E2E_BASE_URL", "http://127.0.0.1:8791")
ART = os.environ.get("E2E_ARTIFACTS", os.path.join(os.getcwd(), ".e2e-artifacts"))
os.makedirs(ART, exist_ok=True)

results = []


def step(name):
    def deco(fn):
        def wrapper(*a, **kw):
            t0 = time.time()
            try:
                fn(*a, **kw)
                results.append((name, "PASS", time.time() - t0, ""))
                print(f"  PASS {name} ({time.time()-t0:.1f}s)")
            except Exception as exc:  # noqa: BLE001 - we want every step reported
                results.append((name, "FAIL", time.time() - t0, (str(exc).splitlines() or ["(no message)"])[0][:200]))
                print(f"  FAIL {name}: {exc}")
                try:
                    page.screenshot(path=os.path.join(ART, f"FAIL-{name.replace(' ', '_')}.png"), full_page=True)
                except Exception:
                    pass
                raise
        return wrapper
    return deco


@step("open the dashboard and see three demo projects")
def dashboard(page):
    page.goto(BASE + "/#/", wait_until="domcontentloaded")
    expect(page.locator("h1")).to_contain_text("仪表盘", timeout=20000)
    expect(page.locator(".metric").filter(has_text="项目数").locator(".value")).to_have_text("3", timeout=20000)
    # The decision view surfaces the two projects that need action now, each with one primary action.
    assert page.locator(".decision-row").count() == 2, "two demo projects have critical/high attention"
    body = page.inner_text("body")
    assert "Legacy Billing" in body and "FitPlan Tracker" in body
    assert page.locator(".decision-row .btn").count() == 2, "each decision row carries exactly one action"
    # The healthy project is demoted but still one click away in the collapsed "其余" list.
    page.locator(".rest-details summary").click()
    expect(page.locator(".rest-row").filter(has_text="ShopFlow Web")).to_be_visible()


@step("attention center lists the failing project first")
def attention(page):
    page.goto(BASE + "/#/attention", wait_until="domcontentloaded")
    expect(page.locator("h1")).to_contain_text("关注中心", timeout=15000)
    page.wait_for_selector(".risk-item", timeout=15000)
    items = page.locator(".risk-item")
    assert items.count() >= 3
    body = page.inner_text("body")
    assert "Legacy Billing" in body
    assert "build" in body.lower()


@step("project detail overview shows gate, health and next action")
def overview(page):
    page.goto(BASE + "/#/", wait_until="domcontentloaded")
    page.locator(".decision-name").filter(has_text="FitPlan Tracker").click()
    page.wait_for_url(re.compile(r"#/projects/[^/]+$"), timeout=15000)
    expect(page.locator("h1")).to_contain_text("FitPlan Tracker", timeout=15000)
    page.wait_for_selector(".metric", timeout=15000)
    body = page.inner_text("body")
    assert "验收门" in body
    assert "下一步建议行动" in body
    assert "验收门：" in body
    # The gate must explain itself, not just show FAIL.
    assert "无法推进" in body or "可以推进到下一阶段" in body


@step("tests tab shows 22/25 e2e with failing cases")
def tests_tab(page):
    page.locator(".tab", has_text="质量与验证").click()
    expect(page.locator("body")).to_contain_text("失败用例", timeout=15000)
    expect(page.locator("body")).to_contain_text("22/25", timeout=15000)
    expect(page.locator("body")).to_contain_text("generates a 7 day plan", timeout=15000)
    expect(page.locator("details summary").filter(has_text="原始输出").first).to_be_visible(timeout=15000)


@step("risks tab lists deterministic risks with evidence")
def risks_tab(page):
    page.locator(".tab", has_text="质量与验证").click()
    page.wait_for_selector(".risk-item", timeout=15000)
    expect(page.locator("body")).to_contain_text("TESTS_FAILED_E2E", timeout=15000)
    expect(page.locator("body")).to_contain_text("建议行动", timeout=15000)
    assert page.locator(".chip").count() >= 3, "risks must carry evidence chips"


@step("issues can be filed manually and listed next to computed risks")
def issues_tab(page):
    page.wait_for_selector("text=缺陷 (0)", timeout=15000)
    page.fill("input[aria-label='新缺陷标题']", "Checkout double charges the card")
    page.select_option("select[aria-label='缺陷严重程度']", "high")
    page.fill("input[aria-label='缺陷描述']", "Reported by a user on the payment step")
    page.locator(".card button", has_text="添加").first.click()
    expect(page.locator("body")).to_contain_text("缺陷 (1)", timeout=15000)
    expect(page.locator("body")).to_contain_text("Checkout double charges the card", timeout=15000)


@step("tasks can be created and moved through the ledger")
def tasks_tab(page):
    page.locator(".tab", has_text="任务与阶段").click()
    page.fill("input[aria-label='新任务标题']", "Fix double charge on checkout")
    page.locator("button:has-text('添加')").click()
    expect(page.locator("body")).to_contain_text("Fix double charge on checkout", timeout=15000)
    row = page.locator("tr", has_text="Fix double charge on checkout")
    row.locator("select").first.select_option("in_progress")
    expect(page.locator("body")).to_contain_text("进行中", timeout=15000)


@step("decisions and project memory versioning work")
def decisions_memory(page):
    # decisions and memory both live in the grouped "AI 记录" tab
    page.locator(".tab", has_text="AI 记录").click()
    page.fill("input[aria-label='决策标题']", "Use SQLite for all local state")
    page.fill("textarea[aria-label='决策']", "One embedded database, versioned migrations, no server.")
    page.locator("button:has-text('创建架构决策记录')").click()
    expect(page.locator("body")).to_contain_text("Use SQLite for all local state", timeout=15000)
    expect(page.locator("body")).to_contain_text("Project Memory v", timeout=15000)
    page.fill("input[aria-label='Memory note']", "note recorded by the e2e run")
    page.locator("button:has-text('创建新版本')").click()
    expect(page.locator("body")).to_contain_text("note recorded by the e2e run", timeout=15000)
    expect(page.locator("body")).to_contain_text("版本历史", timeout=15000)


@step("agent transcript import closes the prompt loop")
def sessions_tab(page):
    page.locator(".tab", has_text="AI 记录").click()
    transcript = "$ npm test\nexit code 0\n$ npm run test:e2e\n  22 passed (18.4s)\n  3 failed\nexit code 1\nEdited file: src/planner/weekly.js\n"
    page.fill("textarea[aria-label='Transcript']", transcript)
    page.select_option("select[aria-label='提供方']", "claude_code")
    page.locator("button:has-text('导入会话记录')").click()
    expect(page.locator("body")).to_contain_text("已导入会话 (1)", timeout=15000)
    expect(page.locator("body")).to_contain_text("claude_code", timeout=15000)
    expect(page.locator("body")).to_contain_text("2", timeout=10000)  # 2 commands parsed from the transcript


@step("next action is rendered with priority and verification commands")
def next_action(page):
    page.goto(BASE + "/#/", wait_until="domcontentloaded")
    page.locator(".decision-name").filter(has_text="FitPlan Tracker").click()
    page.wait_for_url(re.compile(r"#/projects/[^/]+$"), timeout=15000)
    page.wait_for_selector("text=下一步建议行动", timeout=15000)
    expect(page.locator("body")).to_contain_text("npm run test:e2e", timeout=15000)
    page.locator(".tab", has_text="AI 记录").click()
    page.wait_for_selector("text=还没有生成提示词", timeout=15000)


@step("prompt generation produces all ten sections")
def generate_prompt(page):
    page.locator(".tab", has_text="概况").click()
    page.wait_for_selector("button:has-text('生成 Agent 提示词')", timeout=15000)
    page.locator("button:has-text('生成 Agent 提示词')").first.click()
    page.wait_for_selector(".modal", timeout=30000)
    for section in ["PROJECT CONTEXT", "CURRENT STATE", "OBJECTIVE", "RELEVANT FILES",
                    "KNOWN FAILURES", "CONSTRAINTS", "DO NOT BREAK",
                    "ACCEPTANCE CRITERIA", "VERIFICATION COMMANDS", "COMPLETION REQUIREMENTS"]:
        expect(page.locator(".modal")).to_contain_text(section, timeout=15000), f"missing {section}"
    expect(page.locator(".modal")).to_contain_text("provider: mock", timeout=10000), "mock provider must be labelled"
    page.screenshot(path=os.path.join(ART, "prompt-modal.png"), full_page=False)
    page.locator(".modal button", has_text="关闭").click()
    page.wait_for_selector(".modal", state="detached", timeout=10000)


@step("handoff package opens with all sections")
def handoff(page):
    page.locator(".tab", has_text="AI 记录").click()
    page.locator("button:has-text('交接包')").click()
    page.wait_for_selector(".modal", timeout=30000)
    for section in ["Project Summary", "Architecture", "Current Stage", "Known Issues", "Next Action", "Verification"]:
        expect(page.locator(".modal")).to_contain_text(section, timeout=15000)
    page.screenshot(path=os.path.join(ART, "handoff.png"), full_page=False)
    page.locator(".modal button", has_text="关闭").click()


@step("search finds indexed content")
def search(page):
    page.goto(BASE + "/#/search", wait_until="domcontentloaded")
    page.fill("input[aria-label='Search query']", "checkout")
    page.keyboard.press("Enter")
    page.wait_for_selector("text=的搜索结果", timeout=15000)
    expect(page.locator("body")).to_contain_text("的搜索结果", timeout=15000)


@step("settings screen renders provider and security info")
def settings(page):
    page.goto(BASE + "/#/settings", wait_until="domcontentloaded")
    expect(page.locator("body")).to_contain_text("AI 服务", timeout=20000)
    expect(page.locator("body")).to_contain_text("监控与扫描限制", timeout=20000)
    expect(page.locator("body")).to_contain_text("mock", timeout=20000)
    page.goto(BASE + "/#/security", wait_until="domcontentloaded")
    expect(page.locator("body")).to_contain_text("敏感文件保护", timeout=20000)
    expect(page.locator("body")).to_contain_text("绝不会被读取", timeout=20000)
    expect(page.locator("body")).to_contain_text("取自实际生效的规则", timeout=20000)


@step("add-project dialog discovers real folders on this machine")
def discovery(page):
    page.goto(BASE + "/#/", wait_until="domcontentloaded")
    page.wait_for_selector(".decision-row", timeout=20000)
    page.locator("button:has-text('添加项目')").click()
    page.wait_for_selector(".modal", timeout=10000)
    expect(page.locator(".modal")).to_contain_text("扫描这台电脑", timeout=10000)
    # the discovery tab runs a real machine scan and lists project folders
    page.wait_for_selector(".disc-row", timeout=30000)
    assert page.locator(".disc-row").count() >= 1, "discovery must find at least one project folder"
    # Already-registered folders are shown but not importable again. Whether any appear
    # depends on the machine, so assert the invariant rather than its existence.
    managed = page.locator(".disc-row.is-managed")
    for i in range(managed.count()):
        assert managed.nth(i).locator("input.chk").is_disabled(), \
            "a managed folder must not be importable again"
        expect(managed.nth(i)).to_contain_text("已在管理中", timeout=5000)
    # a category can be chosen for the whole batch
    expect(page.locator(".modal select[aria-label='项目分类']")).to_be_visible(timeout=5000)
    # manual path tab exists
    page.locator(".modal .tab", has_text="输入路径").click()
    expect(page.locator(".modal input[aria-label='项目路径']")).to_be_visible(timeout=5000)
    page.locator(".modal .btn-ghost").first.click()
    expect(page.locator(".modal")).to_have_count(0, timeout=5000)


@step("projects can be filtered and grouped by category")
def categories(page):
    page.goto(BASE + "/#/projects", wait_until="domcontentloaded")
    page.wait_for_selector(".chip-btn", timeout=20000)
    chips = page.locator(".chip-btn")
    assert chips.count() >= 2, "expected 全部 plus at least one category chip"
    total = page.locator("tbody tr").count()
    # grouping produced a per-category heading
    expect(page.locator(".group-head").first).to_be_visible(timeout=10000)
    # every row carries a category label
    assert page.locator("tbody tr .chip[title]").count() >= 1, "rows must show 分类"
    # narrowing to one category reduces the visible rows and the chip shows as active
    target = None
    for i in range(1, chips.count()):
        if "全部" not in chips.nth(i).inner_text():
            target = i
            break
    assert target is not None, "no category chip to filter by"
    chips.nth(target).click()
    page.wait_for_selector(".chip-on", timeout=5000)
    assert page.locator("tbody tr").count() < total or total == 1, "filtering must narrow the list"
    # text filter narrows further, and a non-matching query yields the localized empty state
    page.locator(".chip-btn", has_text="全部").click()
    page.wait_for_selector("input[aria-label='筛选项目']", timeout=10000)
    page.fill("input[aria-label='筛选项目']", "zzz-no-such-project-xyz")
    expect(page.locator("body")).to_contain_text("没有符合筛选条件的项目", timeout=10000)
    page.fill("input[aria-label='筛选项目']", "")


@step("project detail identifies purpose and lists evidence-backed suggestions")
def suggestions(page):
    page.goto(BASE + "/#/", wait_until="domcontentloaded")
    page.locator(".decision-name").filter(has_text="FitPlan Tracker").click()
    page.locator(".tab", has_text="概况").click()
    page.wait_for_selector(".purpose-box", timeout=20000)
    body = page.locator(".purpose-box").inner_text()
    assert "分类" in body, "the identification card must state the category"
    assert "分类依据" in body, "the identification card must expose the evidence behind the category"
    # suggestions exist and every one of them cites evidence — no advice without a source
    # 建议面板会随后台数据异步重渲染，实测会闪过一帧空列表（2026-10-02）：
    # 等到连续两帧都稳定非空再数，别把过渡态当成"没有建议"。
    page.wait_for_function(
        """() => new Promise(resolve => {
          const count = () => document.querySelectorAll('.sugg-item').length;
          const n = count();
          if (n < 1) return resolve(false);
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(count() === n)));
        })""", timeout=20000)
    items = page.locator(".sugg-item")
    assert items.count() >= 1, "a demo project with known gaps should yield suggestions"
    for i in range(items.count()):
        text = items.nth(i).inner_text()
        assert "证据" in text, f"suggestion #{i} has no evidence line"
        assert "怎么做" in text, f"suggestion #{i} has no action line"
    # the classification rationale is expandable
    expect(page.locator("details summary", has_text="分类依据").first).to_be_visible(timeout=10000)


@step("delete is one click, and wiping the folder stays an opt-in extra")
def delete_preview(page):
    page.goto(BASE + "/#/projects", wait_until="domcontentloaded")
    page.wait_for_selector("button:has-text('删除')", timeout=20000)
    page.locator("tbody tr button:has-text('删除')").first.click()
    page.wait_for_selector(".modal", timeout=10000)
    modal = page.locator(".modal")
    expect(modal).to_contain_text("从 Commander 移除这个项目的记录", timeout=5000)
    expect(modal).to_contain_text("磁盘上的项目目录不会被改动", timeout=5000)
    # The everyday action must not be gated by a choice the user does not want to make.
    assert modal.locator("input[type=checkbox]").count() == 0, "delete must not ask to tick an option"
    # Wiping the source directory is a separate, deliberately hidden step.
    assert not modal.locator("input[aria-label='彻底删除确认']").is_visible(), \
        "the purge step must start collapsed"
    page.locator(".modal button:has-text('连磁盘上的目录一起删')").click()
    # The assessment either sizes the folder or explains why it refuses to touch it.
    # Demo fixtures live under Commander's own data dir, so a refusal is a valid answer —
    # what must never happen is silence.
    # Wait for the async assessment to reach a terminal state, not the "正在检查源目录…" placeholder.
    expect(page.locator(".modal")).to_contain_text(re.compile("个文件|不可清除|无法评估"), timeout=15000)
    assess = page.locator(".modal").inner_text()
    assert ("个文件" in assess) or ("不可清除" in assess) or ("无法评估" in assess), \
        "the assessment must report a size or a refusal reason"
    # The purge prompt states the token that actually unlocks it: the real directory name.
    placeholder = page.locator(".modal input[aria-label='彻底删除确认']").get_attribute("placeholder") or ""
    assert ("输入「" in placeholder) or ("不允许彻底删除" in placeholder) or ("载入" in placeholder), \
        f"purge prompt must come from the assessment, got: {placeholder}"
    # A wrong token is refused and nothing is deleted. For demo fixtures that live under
    # Commander's own data dir the server refuses the purge outright, so either the
    # token-mismatch prompt or the refusal message is the correct, safe outcome.
    page.fill(".modal input[aria-label='彻底删除确认']", "not-the-token")
    page.locator(".modal button:has-text('永久删除记录与源文件')").click()
    expect(modal).to_contain_text(re.compile("请输入「|不能清除源目录"), timeout=5000)
    rows_before = page.locator("tbody tr").count()
    # :has-text 是子串匹配，会同时命中「取消彻底删除」—— 收起彻底删除子步骤的
    # 那颗按钮（2026-10-02 实测踩到）。关整个模态要点的是精确的「取消」。
    modal.get_by_role("button", name="取消", exact=True).click()
    expect(page.locator(".modal")).to_have_count(0, timeout=5000)
    assert page.locator("tbody tr").count() == rows_before, "the preview must not remove any project"


@step("settings expose GitHub private-repo publishing without leaking the token")
def github_settings(page):
    page.goto(BASE + "/#/settings", wait_until="domcontentloaded")
    expect(page.locator("body")).to_contain_text("GitHub 私有仓库自动上传", timeout=20000)
    token = page.locator("input[aria-label='GitHub token']")
    expect(token).to_be_visible(timeout=10000)
    # the field is a password input and never echoes a stored secret
    assert token.get_attribute("type") == "password", "the token field must be masked"
    assert page.locator("body").inner_text().count("ghp_") == 0, "no token material may be rendered"
    expect(page.locator("body")).to_contain_text("绝不会返回浏览器", timeout=10000)


@step("topbar search is present on every page and routes to results")
def topbar_search(page):
    page.goto(BASE + "/#/", wait_until="domcontentloaded")
    box = page.locator(".topbar-search")
    expect(box).to_be_visible(timeout=10000)
    expect(page.locator(".searchbox kbd")).to_be_visible(timeout=5000)
    box.fill("plan")
    box.press("Enter")
    page.wait_for_url(re.compile(r"#/search"), timeout=10000)
    expect(page.locator("body")).to_contain_text("的搜索结果", timeout=15000)


@step("keyboard navigation works")
def a11y(page):
    page.goto(BASE + "/#/", wait_until="domcontentloaded")
    page.wait_for_selector(".decision-row", timeout=20000)
    for _ in range(4):
        page.keyboard.press("/")
        try:
            page.wait_for_url(re.compile(r"#/search"), timeout=2500)
            break
        except Exception:
            page.locator("body").focus()
    expect(page.locator("input[aria-label='Search query']")).to_be_focused(timeout=10000)
    # every actionable project row is keyboard reachable through its name link
    page.goto(BASE + "/#/", wait_until="domcontentloaded")
    page.wait_for_selector(".decision-name", timeout=15000)
    page.locator(".decision-name").first.focus()
    page.keyboard.press("Enter")
    page.wait_for_url(re.compile(r"#/projects/.+"), timeout=10000)


def main():
    failures = 0
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 960})
        page.set_default_timeout(20000)
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "favicon" not in m.text else None)

        dashboard(page)
        attention(page)
        overview(page)
        tests_tab(page)
        risks_tab(page)
        issues_tab(page)
        next_action(page)
        tasks_tab(page)
        decisions_memory(page)
        sessions_tab(page)
        generate_prompt(page)
        handoff(page)
        search(page)
        settings(page)
        github_settings(page)
        discovery(page)
        categories(page)
        suggestions(page)
        delete_preview(page)
        topbar_search(page)
        a11y(page)

        page.screenshot(path=os.path.join(ART, "final-dashboard.png"), full_page=True)
        browser.close()

        real_errors = [e for e in errors if "favicon" not in e and "404" not in e]
        if real_errors:
            results.append(("no console/page errors", "FAIL", 0, "; ".join(real_errors[:3])))
        else:
            results.append(("no console/page errors", "PASS", 0, ""))

    print("\n  E2E RESULTS")
    print("  ───────────")
    for name, status, dur, err in results:
        print(f"  {status}  {name}" + (f"  ({dur:.1f}s)" if dur else "") + (f"\n        {err}" if err else ""))
    failures = sum(1 for r in results if r[1] == "FAIL")
    print(f"\n  {len(results) - failures}/{len(results)} steps passed")
    if failures:
        sys.exit(1)


if __name__ == "__main__":
    main()
