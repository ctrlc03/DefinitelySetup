import {
    collection as collectionRef,
    doc,
    DocumentData,
    DocumentSnapshot,
    Firestore,
    getDoc,
    getDocs,
    QueryDocumentSnapshot,
    getFirestore,
    query,
    collection,
    where
} from "firebase/firestore"
import { FirebaseApp, FirebaseOptions, initializeApp } from "firebase/app" // ref https://firebase.google.com/docs/web/setup#access-firebase.
import { Functions, getFunctions } from "firebase/functions"
import { processItems } from "./utils"

// we init this here so we can use it throughout the functions below
let firestoreDatabase: Firestore

/**
 * This method initialize a Firebase app if no other app has already been initialized.
 * @param options <FirebaseOptions> - an object w/ every necessary Firebase option to init app.
 * @returns <FirebaseApp> - the initialized Firebase app object.
 */
const initializeFirebaseApp = (options: FirebaseOptions): FirebaseApp => initializeApp(options)

/**
 * This method returns the Firestore database instance associated to the given Firebase application.
 * @param app <FirebaseApp> - the Firebase application.
 * @returns <Firestore> - the Firebase Firestore associated to the application.
 */
const getFirestoreDatabase = (app: FirebaseApp): Firestore => getFirestore(app)

/**
 * This method returns the Cloud Functions instance associated to the given Firebase application.
 * @param app <FirebaseApp> - the Firebase application.
 * @returns <Functions> - the Cloud Functions associated to the application.
 */
const getFirebaseFunctions = (app: FirebaseApp): Functions => getFunctions(app)

/**
 * Get circuits collection path for database reference.
 * @notice all circuits related documents are store under `ceremonies/<ceremonyId>/circuits` collection path.
 * nb. This is a rule that must be satisfied. This is NOT an optional convention.
 * @param ceremonyId <string> - the unique identifier of the ceremony.
 * @returns <string> - the participants collection path.
 */
export const getCircuitsCollectionPath = (ceremonyId: string): string =>
    `ceremonies/${ceremonyId}/circuits`

/**
 * Return the core Firebase services instances (App, Database, Functions).
 * @param apiKey <string> - the API key specified in the application config.
 * @param authDomain <string> - the authDomain string specified in the application config.
 * @param projectId <string> - the projectId specified in the application config.
 * @param messagingSenderId <string> - the messagingSenderId specified in the application config.
 * @param appId <string> - the appId specified in the application config.
 * @returns <Promise<FirebaseServices>>
 */
export const initializeFirebaseCoreServices = async (): Promise<{
    firebaseApp: FirebaseApp
    firestoreDatabase: Firestore
    firebaseFunctions: Functions
}> => {
    const firebaseApp = initializeFirebaseApp({
        apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
        authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
        projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
        messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
        appId: import.meta.env.VITE_FIREBASE_APP_ID
    })
    const firestoreDatabase = getFirestoreDatabase(firebaseApp)
    const firebaseFunctions = getFirebaseFunctions(firebaseApp)

    return {
        firebaseApp,
        firestoreDatabase,
        firebaseFunctions
    }
}

// Init the Firestore database instance.
(async () => {
    const { firestoreDatabase: db } = await initializeFirebaseCoreServices()

    firestoreDatabase = db
})()

/**
 * Fetch for all documents in a collection.
 * @param firestoreDatabase <Firestore> - the Firestore service instance associated to the current Firebase application.
 * @param collection <string> - the name of the collection.
 * @returns <Promise<Array<QueryDocumentSnapshot<DocumentData>>>> - return all documents (if any).
 */
export const getAllCollectionDocs = async (
    collection: string
): Promise<Array<QueryDocumentSnapshot<DocumentData>>> =>
    (await getDocs(collectionRef(firestoreDatabase, collection))).docs

/**
 * Get a specific document from database.
 * @param firestoreDatabase <Firestore> - the Firestore service instance associated to the current Firebase application.
 * @param collection <string> - the name of the collection.
 * @param documentId <string> - the unique identifier of the document in the collection.
 * @returns <Promise<DocumentSnapshot<DocumentData>>> - return the document from Firestore.
 */
export const getDocumentById = async (
    collection: string,
    documentId: string
): Promise<DocumentSnapshot<DocumentData>> => {
    const docRef = doc(firestoreDatabase, collection, documentId)

    return getDoc(docRef)
}

/**
 * Helper for obtaining uid and data for query document snapshots.
 * @param queryDocSnap <Array<QueryDocumentSnapshot>> - the array of query document snapshot to be converted.
 * @returns Array<FirebaseDocumentInfo>
 */
export const fromQueryToFirebaseDocumentInfo = (
    queryDocSnap: Array<QueryDocumentSnapshot>
): Array<any> =>
    queryDocSnap.map((document: QueryDocumentSnapshot<DocumentData>) => ({
        id: document.id,
        ref: document.ref,
        data: document.data()
    }))

/**
 * Query for ceremony circuits.
 * @notice the order by sequence position is fundamental to maintain parallelism among contributions for different circuits.
 * @param firestoreDatabase <Firestore> - the Firestore service instance associated to the current Firebase application.
 * @param ceremonyId <string> - the ceremony unique identifier.
 * @returns Promise<Array<FirebaseDocumentInfo>> - the ceremony' circuits documents ordered by sequence position.
 */
export const getCeremonyCircuits = async (
    ceremonyId: string
): Promise<Array<any>> =>
    fromQueryToFirebaseDocumentInfo(
        await getAllCollectionDocs(getCircuitsCollectionPath(ceremonyId))
    ).sort((a: any, b: any) => a.data.sequencePosition - b.data.sequencePosition)


/**
 * Fetch all avatars for participants of a ceremony.
 * @param ceremonyId {string} - the ceremony unique identifier.
 * @returns {string[]} - An array of avatarURLs. 
 */
export const getParticipantsAvatar = async (
    ceremonyId: string,
): Promise<any> => {
    // Get all participants of the ceremony
    const participantsDocs = await getAllCollectionDocs(`ceremonies/${ceremonyId}/participants`)
    const participantsData = fromQueryToFirebaseDocumentInfo(participantsDocs)

    // Get the IDs of the participants
    const participantIds = participantsData.map(participant => participant.id)

    // Chunk the IDs into groups of 10 or fewer due to Firestore's limitation
    const chunks: any[] = []
    while (participantIds.length) {
        chunks.push(participantIds.splice(0, 10))
    }

    // This function fetches avatars for a given chunk
    const fetchAvatarsForChunk = async (chunk: string[]): Promise<string[]> => {
        const q = query(
            collection(firestoreDatabase, 'avatars'),
            where('__name__', 'in', chunk)
        );

        const avatarDocs = await getDocs(q)

        return avatarDocs.docs
            .filter(doc => doc.exists())
            .map(doc => doc.data().avatarUrl)
    };

    // Process all the chunks concurrently
    // @todo do something with the errors - for now ignore them
    const { results } = await processItems(chunks, fetchAvatarsForChunk, false)
    // Flattening the list of lists of avatar URLs
    const avatarURLs = results.flat()

    return avatarURLs
}


/**
 * Function to get contributions for each circuit
 * @param {Firestore} firestoreDatabase - the Firestore service instance associated to the current Firebase application.
 * @param {string} circuitId - the circuit unique identifier.
 * @param {string} ceremonyId - the ceremony unique identifier.
 * @returns {Array<any>} - An array of contributions for the circuit.
*/ 
export const getContributions = async (
    ceremonyId: string,
    circuitId: string
): Promise<any[]> => {
    const contributionsDocs = await getAllCollectionDocs(`ceremonies/${ceremonyId}/circuits/${circuitId}/contributions`);
    return contributionsDocs.map((document: DocumentData) => ({ uid: document.id, data: document.data() }));
}