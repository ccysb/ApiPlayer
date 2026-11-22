// MV3 background：点击扩展图标时在标签页中打开 ApiPlayer。
const APP_PATH = 'index.html';

async function focusOrCreateTab() {
  const url = chrome.runtime.getURL(APP_PATH);
  try {
    const tabs = await chrome.tabs.query({});
    const target = tabs.find((tab) => {
      return tab.url === url || tab.url.startsWith(url + '?') || tab.url.startsWith(url + '#');
    });
    if (target) {
      if (target.windowId !== undefined) {
        await chrome.windows.update(target.windowId, { focused: true });
      }
      await chrome.tabs.update(target.id, { active: true });
      return;
    }
  } catch (error) {
    // 查询失败时直接新建标签页，保证「点击即打开」。
  }
  await chrome.tabs.create({ url });
}

chrome.action.onClicked.addListener(focusOrCreateTab);
