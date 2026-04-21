const admin = require('firebase-admin');

let initialized = false;

const initializeFirebase = () => {
    if (initialized) return admin;

    try {
        // Load service account from local JSON file
        // In production, consider using environment variables or a secure secret manager instead
        // Path is relative to this file (services/)
        const serviceAccount = require('../ticketing-app-45f15-firebase-adminsdk-fbsvc-16b6e75834.json');

        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });

        initialized = true;
        console.log('Firebase Admin initialized for FCM');
    } catch (error) {
        console.error('Failed to initialize Firebase Admin for FCM:', error.message);
    }

    return admin;
};

const getMessaging = () => {
    const firebase = initializeFirebase();
    if (!firebase.apps || firebase.apps.length === 0) {
        console.error('Firebase Admin not initialized. Cannot send FCM messages.');
        return null;
    }
    return firebase.messaging();
};

/**
 * Send a push notification to a list of FCM tokens.
 * @param {string[]} tokens
 * @param {{ title: string, body: string }} notification
 * @param {Record<string, string>} [data]
 */
const sendNotificationToTokens = async (tokens, notification, data = {}) => {
    if (!tokens || tokens.length === 0) return;

    const messaging = getMessaging();
    if (!messaging) return;

    // Filter out any empty/invalid tokens
    const validTokens = tokens.filter(Boolean);
    if (validTokens.length === 0) return;

    try {
        const message = {
            notification,
            data,
            tokens: validTokens
        };

        const response = await messaging.sendEachForMulticast(message);

        // Optionally log failures for debugging
        if (response.failureCount > 0) {
            console.warn(`FCM: ${response.failureCount} notifications failed`);
        }

        return response;
    } catch (error) {
        console.error('Error sending FCM notification:', error);
    }
};

/**
 * Send a push notification to a single user document (expects user.fcmTokens as string[]).
 * @param {import('../models/user')} user
 * @param {{ title: string, body: string }} notification
 * @param {Record<string, string>} [data]
 */
const sendNotificationToUser = async (user, notification, data = {}) => {
    if (!user || !Array.isArray(user.fcmTokens) || user.fcmTokens.length === 0) {
        return;
    }

    return sendNotificationToTokens(user.fcmTokens, notification, data);
};

module.exports = {
    sendNotificationToTokens,
    sendNotificationToUser
};

