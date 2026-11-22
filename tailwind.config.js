/** Tailwind 预编译配置：供浏览器扩展生成静态 CSS（MV3 禁止 unsafe-eval，不能用 CDN JIT 版） */
export default {
  content: ['./index.html', './extension/index.html', './worker.js'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        primary: {
          50: '#f5f3ff', 100: '#ede9fe', 200: '#ddd6fe', 300: '#c4b5fd', 400: '#a78bfa',
          500: '#8b5cf6', 600: '#7c3aed', 700: '#6d28d9', 800: '#5b21b6', 900: '#4c1d95'
        }
      }
    }
  },
  plugins: []
};
