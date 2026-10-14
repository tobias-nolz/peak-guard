import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export type ThemePref = 'light' | 'dark' | 'system';

const ThemeContext = createContext<{
  pref: ThemePref;
  dark: boolean;
  setPref: (p: ThemePref) => void;
}>({
  pref: 'system',
  dark: false,
  setPref: () => {},
});

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem('theme');
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [pref, setPrefState] = useState<ThemePref>(readPref);
  const [systemDark, setSystemDark] = useState(
    () => matchMedia('(prefers-color-scheme: dark)').matches,
  );

  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const dark = pref === 'dark' || (pref === 'system' && systemDark);
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
  }, [dark]);

  const setPref = (p: ThemePref) => {
    setPrefState(p);
    try {
      localStorage.setItem('theme', p);
    } catch {
      /* private mode */
    }
  };

  return <ThemeContext.Provider value={{ pref, dark, setPref }}>{children}</ThemeContext.Provider>;
}

export const useTheme = () => useContext(ThemeContext);
