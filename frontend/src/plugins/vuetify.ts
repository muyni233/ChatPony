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
          background: '#F6F4EF',
          surface: '#FFFFFF',
          'surface-bright': '#FFFFFF',
          'surface-light': '#F1EEE7',
          'surface-variant': '#E6E1D7',
          'on-background': '#1F1D1A',
          'on-surface': '#1F1D1A',
          'on-surface-variant': '#5E584F',
          primary: '#245C50',
          'on-primary': '#FFFFFF',
          'primary-container': '#D3EDE5',
          'on-primary-container': '#0B2E26',
          secondary: '#5E5480',
          'on-secondary': '#FFFFFF',
          'secondary-container': '#E9E4FA',
          'on-secondary-container': '#1E1736',
          tertiary: '#A3553E',
          'on-tertiary': '#FFFFFF',
          'tertiary-container': '#FBE3DB',
          'on-tertiary-container': '#3B1208',
          error: '#B3261E',
          success: '#2E6B4F',
          warning: '#9A6315',
          info: '#245C50',
        },
        variables: {
          'border-color': '#2A251E',
          'border-opacity': 0.09,
        },
      },
      dark: {
        dark: true,
        colors: {
          background: '#121110',
          surface: '#1B1A18',
          'surface-bright': '#2A2825',
          'surface-light': '#201F1C',
          'surface-variant': '#302D29',
          'on-background': '#ECE8E1',
          'on-surface': '#ECE8E1',
          'on-surface-variant': '#B8B0A5',
          primary: '#8ED3C1',
          'on-primary': '#04372D',
          'primary-container': '#1C4A40',
          'on-primary-container': '#C6EEE3',
          secondary: '#CBC1F2',
          'on-secondary': '#2D244A',
          'secondary-container': '#3B3358',
          'on-secondary-container': '#ECE6FF',
          tertiary: '#F2B5A3',
          'on-tertiary': '#531F12',
          'tertiary-container': '#5E2D20',
          'on-tertiary-container': '#FFDAD0',
          error: '#FFB4AB',
          success: '#8FD7B1',
          warning: '#F4C07A',
          info: '#8ED3C1',
        },
        variables: {
          'border-color': '#FFFFFF',
          'border-opacity': 0.08,
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
      rounded: 'lg',
    },
    VDialog: {
      VCard: { rounded: 'xl' },
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
    VChip: {
      rounded: 'md',
    },
    VList: {
      bgColor: 'transparent',
    },
  },
});
