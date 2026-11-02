/**
 * 「课研」主题：暖白纸张、石墨文字与低饱和绿。
 * 与全局样式共用色值，强调色只承担操作、选中及状态反馈。
 */
export const palette = {
  primary: '#526A5D',
  primarySoft: '#EAF0EA',
  bg: '#F6F5F1',
  card: '#FFFEFB',
  border: '#DDDFD7',
  text: '#303832',
  textSecondary: '#646D65',
  radius: 12,
  fontFamily:
    "'Inter', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
};

const themeConfig = {
  token: {
    colorPrimary: palette.primary,
    colorInfo: palette.primary,
    colorSuccess: palette.primary,
    colorWarning: '#876936',
    colorError: '#A05048',
    colorLink: palette.primary,
    colorTextBase: palette.text,
    colorBgBase: palette.bg,
    colorBgLayout: palette.bg,
    colorBgContainer: palette.card,
    colorBgElevated: palette.card,
    colorBorder: palette.border,
    colorBorderSecondary: '#E8E9E2',
    colorText: palette.text,
    colorTextSecondary: palette.textSecondary,
    colorTextTertiary: '#6D756D',
    colorTextPlaceholder: '#737B73',
    borderRadius: 8,
    borderRadiusLG: palette.radius,
    fontFamily: palette.fontFamily,
    fontSize: 14,
    controlHeight: 40,
    boxShadow: '0 8px 24px rgba(48, 56, 50, 0.08)',
    boxShadowSecondary: '0 12px 40px rgba(48, 56, 50, 0.10)',
    lineWidth: 1,
    wireframe: false,
  },
  components: {
    Layout: {
      bodyBg: palette.bg,
      headerBg: 'transparent',
    },
    Button: {
      fontWeight: 500,
      primaryShadow: 'none',
      defaultShadow: 'none',
      borderRadius: 8,
      controlHeight: 40,
      controlHeightLG: 44,
    },
    Card: {
      borderRadiusLG: palette.radius,
      paddingLG: 24,
      colorBorderSecondary: palette.border,
    },
    Input: {
      activeShadow: '0 0 0 3px rgba(82, 106, 93, 0.12)',
      borderRadius: 8,
      paddingBlock: 7,
    },
    Select: {
      optionSelectedBg: palette.primarySoft,
    },
    Modal: {
      borderRadiusLG: 12,
      titleFontSize: 20,
    },
    Dropdown: {
      borderRadiusLG: 12,
      paddingBlock: 5,
    },
    Tag: {
      borderRadiusSM: 6,
      defaultBg: '#F0F1EB',
      defaultColor: '#646D65',
    },
    Progress: {
      defaultColor: palette.primary,
      remainingColor: '#E8E9E2',
    },
    Message: {
      contentBg: '#FFFFFF',
    },
    Empty: {
      colorTextDescription: palette.textSecondary,
    },
    Drawer: {
      colorBgElevated: palette.card,
    },
  },
};

export default themeConfig;
