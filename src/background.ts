function openPackagedOptions() {
  chrome.runtime.openOptionsPage();
}

function openDevOptions(devOptionsUrl: string) {
  chrome.tabs.create({ url: devOptionsUrl });
}

chrome.action.onClicked.addListener(() => {
  const devOptionsUrl = __DEV_OPTIONS__;
  if (devOptionsUrl) openDevOptions(devOptionsUrl);
  else openPackagedOptions();
});
