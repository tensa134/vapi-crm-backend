const express = require('express');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());

const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

function getPhoneNumberFromCall(call) {
    if (!call?.customer?.number) {
        return null;
    }
    let number = call.customer.number;
    if (number.startsWith('sip:')) {
        const atIndex = number.indexOf('@');
        if (atIndex !== -1) {
            number = number.substring(4, atIndex);
        }
    }
    return number;
}

app.post('/api/handler', async (req, res) => {
    const { message } = req.body;

    if (message.type === 'tool-call' && message.toolCall.name === 'databaseCheck') {
        const phoneNumber = getPhoneNumberFromCall(message.call);
        if (!phoneNumber) {
             console.warn('Database check tool call with no phone number. Treating as new caller.');
             return res.status(200).json({ result: 'New caller' });
        }
        console.log(`Tool call received: databaseCheck for ${phoneNumber}`);
        try {
            const callersRef = db.collection('callers');
            const snapshot = await callersRef.where('phoneNumber', '==', phoneNumber).limit(1).get();
            if (snapshot.empty) {
                console.log(`New caller. Returning status.`);
                return res.status(200).json({ result: 'New caller' });
            } else {
                console.log(`Existing caller. Returning data.`);
                const callerData = snapshot.docs[0].data();
                const lastCall = callerData.callHistory[callerData.callHistory.length - 1] || {};
                const resultPayload = {
                    status: 'Existing caller',
                    name: callerData.name || 'Unknown',
                    lastCallSummary: lastCall.summary || 'No previous summary available.'
                };
                return res.status(200).json({ result: JSON.stringify(resultPayload) });
            }
        } catch (error) {
            console.error('Database check tool error:', error);
            return res.status(500).json({ result: 'Error checking database' });
        }
    }

    if (message.type === 'end-of-call-report') {
        // --- DEBUGGING STEP: PRINT THE ENTIRE MESSAGE OBJECT ---
        console.log("--- START OF END-OF-CALL-REPORT OBJECT ---");
        console.log(JSON.stringify(message, null, 2));
        console.log("--- END OF END-OF-CALL-REPORT OBJECT ---");

        const callerPhoneNumber = getPhoneNumberFromCall(message.call);

        if (!callerPhoneNumber) {
            console.warn('End-of-call report received with no parsable phone number. Skipping.');
            return res.status(200).send();
        }

        try {
            const { summary, transcript } = message;
            const analysis = await analyzeCallSummary(summary, transcript);
            const newCallRecord = {
              date: new Date().toISOString(),
              summary,
              callStatus: analysis.callStatus || 'Connected-IB',
              leadStatus: analysis.leadStatus || 'Uncertain',
              followupDate: analysis.followupDate || 'N/A',
              remark: analysis.remark || 'No remark.',
              transcript,
            };

            const callersRef = db.collection('callers');
            const snapshot = await callersRef.where('phoneNumber', '==', callerPhoneNumber).limit(1).get();

            if (snapshot.empty) {
                const callerInfo = extractCallerInfo(transcript);
                await callersRef.add({
                    phoneNumber: callerPhoneNumber,
                    name: callerInfo.name,
                    course: callerInfo.course,
                    city: callerInfo.city,
                    state: callerInfo.state,
                    userType: callerInfo.userType,
                    createdAt: new Date().toISOString(),
                    callHistory: [newCallRecord]
                });
            } else {
                const callerDoc = snapshot.docs[0];
                const existingData = callerDoc.data();
                const updatedHistory = [...existingData.callHistory, newCallRecord];
                await callerDoc.ref.update({ callHistory: updatedHistory });
            }
            return res.status(200).send();
        } catch (error) {
            console.error('End of call processing error:', error);
            return res.status(500).send();
        }
    }

    return res.status(200).send();
});

async function analyzeCallSummary(summary, transcript) {
  const apiKey = process.env.GEMINI_API_KEY;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
  const prompt = `
    Analyze the following phone call summary and transcript for "Justauto Solution Pvt. Ltd.".
    Your response MUST be a valid JSON object with ONLY the following keys. Adhere strictly to the provided values.
    1. "callStatus": Choose ONE: "Connected-IB", "Connected-OB", "No Answer", "Switched off", "Out of service", "Not reachable", "Call disconnected by customer", "Busy", "Visited Center"
    2. "leadStatus": Choose ONE: "Interested", "Not Interested", "Interested In Future", "Call Back", "Call Back In Evening", "Call Disconnected By Customer", "Booked", "Enquiry For Tools", "Enquiry For Job", "Enquiry For Franchise", "Busy", "Applicant Not Available"
    3. "followupDate": Analyze phrases like "call me in 2 days". Today's date is ${new Date().toISOString().split('T')[0]}. Provide date in "YYYY-MM-DD" format or "N/A".
    4. "remark": Generate a concise, one-sentence summary under 100 characters.
    Summary: "${summary}"
    Transcript: "${transcript}"
  `;
  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: "application/json" }
  };
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!response.ok) throw new Error(`API request failed with status ${response.status}`);
    const data = await response.json();
    return JSON.parse(data.candidates[0].content.parts[0].text);
  } catch (error) {
    console.error("Gemini analysis error:", error);
    return {
        callStatus: 'Connected-IB',
        leadStatus: 'Uncertain',
        followupDate: 'N/A',
        remark: 'Error during AI analysis.'
    };
  }
}

function extractCallerInfo(transcript) {
    const info = { name: 'Unknown', course: 'Unknown', city: 'Unknown', state: 'Unknown', userType: 'Unknown' };
    const userTypeRegex = /(student|guardian|employee|garage owner|unemployed|other)/i;
    const userTypeMatch = transcript.match(userTypeRegex);
    if (userTypeMatch) info.userType = userTypeMatch[0].charAt(0).toUpperCase() + userTypeMatch[0].slice(1);
    const nameRegex = /my name is ([\w\s]+?)(?=\.|\s|$|,|and I'm|and I am)/i;
    const nameMatch = transcript.match(nameRegex);
    if (nameMatch) info.name = nameMatch[1].trim();
    const courseRegex = /interested in the ([\w\s+]+?)\s*course/i;
    const courseMatch = transcript.match(courseRegex);
    if (courseMatch) info.course = courseMatch[1].trim();
    const cityStateRegex = /from ([\w\s]+),\s*([\w\s]+)/i;
    const cityStateMatch = transcript.match(cityStateRegex);
    if (cityStateMatch) {
        info.city = cityStateMatch[1].trim();
        info.state = cityStateMatch[2].trim();
    } else {
        const cityRegex = /(?:from|in)\s([\w\s]+)/i;
        const cityMatch = transcript.match(cityRegex);
        if (cityMatch) info.city = cityMatch[1].trim().replace(/,$/, '');
    }
    return info;
}

module.exports = app;
