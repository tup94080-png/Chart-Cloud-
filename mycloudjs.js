// Initialize Firebase Config dynamically from .env
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID
};

firebase.initializeApp(firebaseConfig);
const db = firebase.database();
const auth = firebase.auth();

// Apps Script URL dynamically from .env
const APPS_SCRIPT_URL = import.meta.env.VITE_APPS_SCRIPT_URL;

// Dynamically set Google Client ID
const gIdContainer = document.getElementById('g_id_onload');
if (gIdContainer) {
  gIdContainer.setAttribute('data-client_id', import.meta.env.VITE_GOOGLE_CLIENT_ID);
  gIdContainer.setAttribute('data-callback', 'handleCredentialResponse');
}

let currentUser = { uid: null, name: "User", avatar: "https://via.placeholder.com/40", isAdmin: false };
let activeChatType = "global";
let currentDmRecipient = null;
let replyTarget = null;
let typingTimeout = null;
let messageListenerRef = null;

function parseJwt(token) {
  const base64Url = token.split('.')[1];
  const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
  const jsonPayload = decodeURIComponent(atob(base64).split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join(''));
  return JSON.parse(jsonPayload);
}

window.handleCredentialResponse = function(response) {
  const payload = parseJwt(response.credential);
  currentUser.name = payload.name;
  currentUser.avatar = payload.picture;

  auth.signInAnonymously().then((cred) => {
    currentUser.uid = cred.user.uid;
    localStorage.setItem('chatUserSession', JSON.stringify(currentUser));
    setupUserSession();
  }).catch(err => {
    alert("Authentication Error: " + err.message);
  });
};

auth.onAuthStateChanged((user) => {
  if (user) {
    const savedUser = localStorage.getItem('chatUserSession');
    if (savedUser) {
      const parsed = JSON.parse(savedUser);
      currentUser.name = parsed.name || "User";
      currentUser.avatar = parsed.avatar || "https://via.placeholder.com/40";
    }
    currentUser.uid = user.uid;
    setupUserSession();
  } else {
    document.getElementById('authOverlay').style.display = 'flex';
  }
});

function setupUserSession() {
  document.getElementById('editUsername').value = currentUser.name;
  document.getElementById('editAvatar').value = currentUser.avatar;
  document.getElementById('headerAvatar').src = currentUser.avatar;
  document.getElementById('authOverlay').style.display = 'none';

  setUserPresence();
  listenForOnlineUsers();
  listenForMessages();
}

function setUserPresence() {
  const presenceRef = db.ref('presence/' + currentUser.uid);
  presenceRef.set({
    name: currentUser.name,
    avatar: currentUser.avatar,
    online: true
  });
  presenceRef.onDisconnect().remove();
}

function listenForOnlineUsers() {
  db.ref('presence').on('value', (snapshot) => {
    const list = document.getElementById('onlineUsersList');
    list.innerHTML = '';
    snapshot.forEach((child) => {
      const uid = child.key;
      const user = child.val();
      if (uid !== currentUser.uid) {
        const card = document.createElement('div');
        card.className = 'user-card';
        card.innerHTML = `
          <div class="user-card-info">
            <img src="${user.avatar || 'https://via.placeholder.com/40'}" class="user-card-avatar" alt="User">
            <span style="font-size: 13px; font-weight: 500;">${user.name}</span>
          </div>
          <button class="chat-cta-btn" data-uid="${uid}" data-name="${user.name.replace(/"/g, '&quot;')}">
            <i class="fa-solid fa-hand-pointer"></i> Chat with me
          </button>
        `;
        list.appendChild(card);
      }
    });

    list.querySelectorAll('.chat-cta-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const targetUid = e.currentTarget.getAttribute('data-uid');
        const targetName = e.currentTarget.getAttribute('data-name');
        startDM(targetUid, targetName);
      });
    });
  });
}

function getDMPath(uid1, uid2) {
  const sorted = [uid1, uid2].sort();
  return `direct_messages/${sorted[0]}_${sorted[1]}`;
}

function startDM(targetUid, targetName) {
  activeChatType = "dm";
  currentDmRecipient = { uid: targetUid, name: targetName };
  document.getElementById('chatRoomTitle').textContent = `DM: ${targetName}`;
  toggleUsersDrawer();
  listenForMessages();
}

function openGlobalChat() {
  activeChatType = "global";
  currentDmRecipient = null;
  document.getElementById('chatRoomTitle').textContent = "Global Workspace";
  toggleUsersDrawer();
  listenForMessages();
}

function signOutUser() {
  db.ref('presence/' + currentUser.uid).remove();
  localStorage.removeItem('chatUserSession');
  auth.signOut().then(() => location.reload());
}

function sendMessage(mediaUrl = null, mimeType = null) {
  const input = document.getElementById('messageInput');
  const text = input.value.trim();
  if (!text && !mediaUrl) return;

  const msgData = {
    senderId: currentUser.uid,
    senderName: currentUser.name,
    text: text,
    mediaUrl: mediaUrl,
    mimeType: mimeType,
    timestamp: Date.now(),
    replyTo: replyTarget ? replyTarget : null
  };

  const path = activeChatType === "global" 
    ? 'messages' 
    : getDMPath(currentUser.uid, currentDmRecipient.uid);

  db.ref(path).push(msgData).then(() => {
    input.value = '';
    cancelReply();
    scrollToBottom();
  });
}

function listenForMessages() {
  if (messageListenerRef) {
    messageListenerRef.off();
  }

  const container = document.getElementById('messagesContainer');
  container.innerHTML = '';

  const path = activeChatType === "global" 
    ? 'messages' 
    : getDMPath(currentUser.uid, currentDmRecipient.uid);

  messageListenerRef = db.ref(path);
  messageListenerRef.on('child_added', (snapshot) => {
    renderMessage(snapshot.key, snapshot.val());
    scrollToBottom();
  });
}

function scrollToBottom() {
  const container = document.getElementById('messagesContainer');
  container.scrollTop = container.scrollHeight;
}

function renderMessage(id, msg) {
  const container = document.getElementById('messagesContainer');
  if (document.querySelector(`[data-id="${id}"]`)) return;

  const isSent = msg.senderId === currentUser.uid;
  const row = document.createElement('div');
  row.className = `message-row ${isSent ? 'sent' : 'received'}`;
  row.setAttribute('data-id', id);

  let mediaHTML = '';
  if (msg.mediaUrl) {
    if (msg.mimeType && msg.mimeType.startsWith('image/')) {
      mediaHTML = `<img src="${msg.mediaUrl}" class="media-thumb" loading="lazy"/>`;
    } else {
      mediaHTML = `<a href="${msg.mediaUrl}" target="_blank" style="font-size:12px; color:#027eb5;"> Attachment</a>`;
    }
  }

  row.innerHTML = `
    <div class="message-bubble">
      <div class="message-header">
        <span>${msg.senderName}</span>
        <span>${new Date(msg.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
      </div>
      <div>${msg.text}</div>
      ${mediaHTML}
      <div class="message-actions">
        <i class="fa-solid fa-reply btn-reply"></i>
      </div>
    </div>
  `;

  row.querySelector('.btn-reply').addEventListener('click', () => {
    setReplyTarget(msg.senderName, msg.text || 'Media');
  });

  container.appendChild(row);
}

function handleFileUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function(e) {
    const rawBytes = e.target.result.split(',')[1];
    fetch(APPS_SCRIPT_URL, {
      method: "POST",
      body: JSON.stringify({ filename: file.name, mimeType: file.type, fileData: rawBytes })
    })
    .then(res => res.json())
    .then(data => {
      if (data.status === "success") {
        sendMessage(`https://lh3.googleusercontent.com/d/${data.fileId}`, data.mimeType);
      }
    });
  };
  reader.readAsDataURL(file);
}

function handleTyping() {
  db.ref('typing/' + currentUser.uid).set({ name: currentUser.name });
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => db.ref('typing/' + currentUser.uid).remove(), 2000);
}

db.ref('typing').on('value', (snapshot) => {
  const indicator = document.getElementById('typingIndicator');
  let typers = [];
  snapshot.forEach(child => {
    if (child.key !== currentUser.uid) typers.push(child.val().name);
  });
  indicator.textContent = typers.length ? `${typers.join(', ')} typing...` : '';
});

function setReplyTarget(name, text) {
  replyTarget = { senderName: name, text: text };
  document.getElementById('replyBannerText').textContent = `Replying to ${name}: "${text}"`;
  document.getElementById('replyBanner').style.display = 'flex';
}

function cancelReply() {
  replyTarget = null;
  document.getElementById('replyBanner').style.display = 'none';
}

function toggleDrawer() {
  document.getElementById('sideDrawer').classList.toggle('open');
}

function toggleUsersDrawer() {
  document.getElementById('usersDrawer').classList.toggle('open');
}

function updateProfile() {
  currentUser.name = document.getElementById('editUsername').value;
  currentUser.avatar = document.getElementById('editAvatar').value;
  localStorage.setItem('chatUserSession', JSON.stringify(currentUser));
  document.getElementById('headerAvatar').src = currentUser.avatar;
  setUserPresence();
  toggleDrawer();
}

// Event Listeners
document.getElementById('btnToggleUsers').addEventListener('click', toggleUsersDrawer);
document.getElementById('btnToggleSettings').addEventListener('click', toggleDrawer);
document.getElementById('btnCloseSettings').addEventListener('click', toggleDrawer);
document.getElementById('btnCloseUsers').addEventListener('click', toggleUsersDrawer);
document.getElementById('btnGlobalChat').addEventListener('click', openGlobalChat);
document.getElementById('btnCancelReply').addEventListener('click', cancelReply);
document.getElementById('btnSaveProfile').addEventListener('click', updateProfile);
document.getElementById('btnSignOut').addEventListener('click', signOutUser);
document.getElementById('sendBtn').addEventListener('click', () => sendMessage());
document.getElementById('btnAttachFile').addEventListener('click', () => document.getElementById('fileInput').click());
document.getElementById('fileInput').addEventListener('change', handleFileUpload);

document.getElementById('messageInput').addEventListener('input', handleTyping);
document.getElementById('messageInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendMessage();
});

document.getElementById('notifBell').addEventListener('click', () => {
  if ("Notification" in window) {
    Notification.requestPermission();
  }
});

