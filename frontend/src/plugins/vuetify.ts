import '@mdi/font/css/materialdesignicons.css';
import 'vuetify/styles';
import { createVuetify } from 'vuetify';
import { md3 } from 'vuetify/blueprints';

export const vuetify = createVuetify({
  blueprint: md3,
  theme: {
    defaultTheme: 'light',
    themes: {
      light: {
        dark: false,
        colors: {
          'background': '#F5FBF7',
          'on-background': '#171D1B',
          'surface': '#F5FBF7',
          'surface-dim': '#D5DBD8',
          'surface-bright': '#F5FBF7',
          'surface-container-lowest': '#FFFFFF',
          'surface-container-low': '#EFF5F1',
          'surface-container': '#E9EFEC',
          'surface-container-high': '#E3EAE6',
          'surface-container-highest': '#DEE4E0',
          'on-surface': '#171D1B',
          'surface-variant': '#DBE5E0',
          'on-surface-variant': '#3F4946',
          'outline': '#6F7976',
          'outline-variant': '#BFC9C4',
          'inverse-surface': '#2B3230',
          'inverse-on-surface': '#ECF2EE',
          'inverse-primary': '#85D6C1',
          'primary': '#076B5B',
          'on-primary': '#FFFFFF',
          'primary-container': '#A0F2DD',
          'on-primary-container': '#005144',
          'secondary': '#4B635C',
          'on-secondary': '#FFFFFF',
          'secondary-container': '#CDE8DF',
          'on-secondary-container': '#334B45',
          'tertiary': '#436278',
          'on-tertiary': '#FFFFFF',
          'tertiary-container': '#C8E6FF',
          'on-tertiary-container': '#2A4A5F',
          'error': '#BA1A1A',
          'on-error': '#FFFFFF',
          'error-container': '#FFDAD6',
          'on-error-container': '#93000A',
          'surface-light': '#E9EFEC',
          'success': '#2E7D5B',
          'warning': '#8A5A00',
          'info': '#436278'
        },
        variables: {
          'border-color': '#171D1B',
          'border-opacity': 0.12,
        },
      },
      dark: {
        dark: true,
        colors: {
          'background': '#0E1513',
          'on-background': '#DEE4E0',
          'surface': '#0E1513',
          'surface-dim': '#0E1513',
          'surface-bright': '#343B38',
          'surface-container-lowest': '#090F0E',
          'surface-container-low': '#171D1B',
          'surface-container': '#1B211F',
          'surface-container-high': '#252B29',
          'surface-container-highest': '#303634',
          'on-surface': '#DEE4E0',
          'surface-variant': '#3F4946',
          'on-surface-variant': '#BFC9C4',
          'outline': '#89938F',
          'outline-variant': '#3F4946',
          'inverse-surface': '#DEE4E0',
          'inverse-on-surface': '#2B3230',
          'inverse-primary': '#076B5B',
          'primary': '#85D6C1',
          'on-primary': '#00382E',
          'primary-container': '#005144',
          'on-primary-container': '#A0F2DD',
          'secondary': '#B1CCC4',
          'on-secondary': '#1D352F',
          'secondary-container': '#334B45',
          'on-secondary-container': '#CDE8DF',
          'tertiary': '#AACBE4',
          'on-tertiary': '#113447',
          'tertiary-container': '#2A4A5F',
          'on-tertiary-container': '#C8E6FF',
          'error': '#FFB4AB',
          'on-error': '#690005',
          'error-container': '#93000A',
          'on-error-container': '#FFDAD6',
          'surface-light': '#1B211F',
          'success': '#8FD7B1',
          'warning': '#F4C07A',
          'info': '#AACBE4'
        },
        variables: {
          'border-color': '#DEE4E0',
          'border-opacity': 0.14,
        },
      },
    },
  },
  defaults: {
    ...md3.defaults,
    // M3: filled cards on tonal surface containers, medium (12dp) corners
    VCard: {
      rounded: 'lg',
      elevation: 0,
      color: 'surface-container-low',
    },
    // M3: full-rounded (pill) buttons
    VBtn: {
      rounded: 'pill',
    },
    // M3: dialogs use extra-large (28dp) corners on surface-container-high
    VDialog: {
      VCard: { rounded: 'xl', color: 'surface-container-high' },
    },
    VMenu: {
      VList: { bgColor: 'surface-container', rounded: 'sm' },
    },
    VNavigationDrawer: {
      elevation: 0,
    },
    VTooltip: {
      location: 'top',
      openDelay: 300,
    },
    VTextField: {
      variant: 'outlined',
      density: 'comfortable',
      color: 'primary',
      hideDetails: 'auto',
    },
    VSelect: {
      variant: 'outlined',
      density: 'comfortable',
      color: 'primary',
      hideDetails: 'auto',
    },
    VTextarea: {
      variant: 'outlined',
      density: 'comfortable',
      color: 'primary',
      hideDetails: 'auto',
    },
    VSwitch: {
      color: 'primary',
      inset: true,
      hideDetails: 'auto',
    },
    // M3: chips use small (8dp) corners
    VChip: {
      rounded: 'sm',
    },
    VBtnToggle: {
      rounded: 'pill',
    },
    VList: {
      bgColor: 'transparent',
    },
  },
});
