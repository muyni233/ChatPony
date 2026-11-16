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
          background: '#F4EFE5',
          surface: '#FFFCF6',
          'surface-bright': '#FFFFFF',
          'surface-light': '#ECE5D8',
          'surface-variant': '#E2D9C8',
          'on-surface-variant': '#5B5349',
          primary: '#2B594F',
          'on-primary': '#FFFFFF',
          'primary-container': '#BFE8DC',
          'on-primary-container': '#072A23',
          secondary: '#5B507A',
          'on-secondary': '#FFFFFF',
          'secondary-container': '#E6DFFD',
          'on-secondary-container': '#1B1333',
          tertiary: '#944C38',
          'on-tertiary': '#FFFFFF',
          'tertiary-container': '#FFDAD0',
          'on-tertiary-container': '#3B1006',
          error: '#B93232',
          success: '#25684B',
          warning: '#9A6315',
          info: '#2B594F',
        },
      },
      dark: {
        dark: true,
        colors: {
          background: '#13110E',
          surface: '#1D1A16',
          'surface-bright': '#2D2821',
          'surface-light': '#25211C',
          'surface-variant': '#352F27',
          'on-surface-variant': '#C5BBB0',
          primary: '#8FD2C1',
          'on-primary': '#06352C',
          'primary-container': '#18493F',
          'on-primary-container': '#BFECE0',
          secondary: '#CEC3F3',
          'on-secondary': '#2D234A',
          'secondary-container': '#433862',
          'on-secondary-container': '#ECE6FF',
          tertiary: '#F5B7A6',
          'on-tertiary': '#532114',
          'tertiary-container': '#703626',
          'on-tertiary-container': '#FFDAD0',
          error: '#FFB4AB',
          success: '#8FD7B1',
          warning: '#F4C07A',
          info: '#8FD2C1',
        },
      },
    },
  },
  defaults: {
    ...md3.defaults,
    VCard: {
      rounded: 'xl',
      elevation: 0,
    },
    VBtn: {
      rounded: 'pill',
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
    VChip: {
      rounded: 'lg',
    },
  },
});
