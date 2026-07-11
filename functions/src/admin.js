'use strict';

const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const app = getApps().length ? getApps()[0] : initializeApp();
const db = getFirestore(app);

module.exports = { app, db };
