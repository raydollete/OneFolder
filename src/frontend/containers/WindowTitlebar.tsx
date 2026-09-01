import { observer } from 'mobx-react-lite';
import React, { useEffect, useState } from 'react';

import { IS_MAC } from 'common/process';
import { WindowSystemButtonPress } from 'src/ipc/messages';
import platform from 'src/frontend/platform';
import { IconSet } from 'widgets/icons';
import { useStore } from '../contexts/StoreContext';

const WindowsTitlebar = () => {
  const [isFocused, setIsFocused] = useState(true);
  useEffect(() => {
    const removeFocusHandler = platform.desktop.onFocus(() => setIsFocused(true));
    const removeBlurHandler = platform.desktop.onBlur(() => setIsFocused(false));

    return () => {
      removeFocusHandler();
      removeBlurHandler();
    };
  }, []);

  return (
    <div id="window-titlebar" className={isFocused ? undefined : 'inactive'}>
      <div id="window-resize-area" />

      <WindowTitlebar />

      {!IS_MAC && <WindowSystemButtons />}
    </div>
  );
};

const WindowTitlebar = observer(() => {
  // This is its own component to avoid rerendering the whole WindowsTitlebar

  const rootStore = useStore();

  /* Extra span needed for ellipsis; isn't compatible with display: flex */
  return (
    <span>
      <span>{rootStore.getWindowTitle()}</span>
    </span>
  );
});

export default WindowsTitlebar;

const WindowSystemButtons = () => {
  const [isMaximized, setMaximized] = useState(() => platform.desktop.isMaximized());
  useEffect(() => {
    const removeUnmaximizeHandler = platform.desktop.onUnmaximize(() => setMaximized(false));
    const removeMaximizeHandler = platform.desktop.onMaximize(() => setMaximized(true));

    return () => {
      removeUnmaximizeHandler();
      removeMaximizeHandler();
    };
  }, []);

  return (
    <div id="window-system-buttons">
      <button
        onClick={() => platform.desktop.pressWindowSystemButton(WindowSystemButtonPress.Minimize)}
      >
        {IconSet.CHROME_MINIMIZE}
      </button>
      <button
        onClick={() =>
          platform.desktop.pressWindowSystemButton(
            isMaximized ? WindowSystemButtonPress.Restore : WindowSystemButtonPress.Maximize,
          )
        }
      >
        {isMaximized ? IconSet.CHROME_RESTORE : IconSet.CHROME_MAXIMIZE}
      </button>
      <button
        onClick={() => platform.desktop.pressWindowSystemButton(WindowSystemButtonPress.Close)}
      >
        {IconSet.CHROME_CLOSE}
      </button>
    </div>
  );
};
