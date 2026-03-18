// Modules
const api = require('webuntis');
const mysql = require('mysql2/promise');
const TelegramBot = require('node-telegram-bot-api');
const dateTools = require('date-fns')
const config = require('./config.json');

const ru = require('./ru.json');
const en = require('./en.json');
const de = require('./de.json');
const encrypt = require('./encrypter/encrypter')
const decrypt = require('./encrypter/decrypter')

// telegram ids
const owner = config.owner;
const dataChannel = config.dataChannel;
const errChannel = config.errChannel;
const school = config.school;
const domain = config.domain;

// Functions && Variables
const isChanging = []
const prevData = {}
const bot = new TelegramBot(config.token, { polling: true });
const menuButton = (lang) => [{ text: `${lang.menu.buttons.text}`, callback_data: 'menu' }]
const dbConfig = {
    host: config.host,
    user: config.user,
    password: config.password,
    database: config.dbname
}

const ensureUsersTable = async () => {
    const connection = await mysql.createConnection(dbConfig);
    try {
        await connection.query(
            `CREATE TABLE IF NOT EXISTS users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                telegramid BIGINT NOT NULL UNIQUE,
                msgid BIGINT NOT NULL DEFAULT 0,
                notif VARCHAR(10) NOT NULL DEFAULT 'yes',
                lang VARCHAR(10) NULL,
                view VARCHAR(10) NOT NULL DEFAULT 'day',
                username_encrypted TEXT NULL,
                password_encrypted TEXT NULL
            )`
        );

        const [usernameColumn] = await connection.query(`SHOW COLUMNS FROM users LIKE 'username_encrypted'`);
        if (usernameColumn.length === 0) {
            await connection.query(`ALTER TABLE users ADD COLUMN username_encrypted TEXT NULL`);
        }

        const [passwordColumn] = await connection.query(`SHOW COLUMNS FROM users LIKE 'password_encrypted'`);
        if (passwordColumn.length === 0) {
            await connection.query(`ALTER TABLE users ADD COLUMN password_encrypted TEXT NULL`);
        }
    } finally {
        await connection.end();
    }
}

const clearUntisCredentials = async (connection, telegramId) => {
    await connection.query(
        `UPDATE users SET msgid = 0, username_encrypted = NULL, password_encrypted = NULL WHERE telegramid = ?`,
        [telegramId]
    );
}

const saveUntisCredentials = async (connection, telegramId, username, password) => {
    await connection.query(
        `UPDATE users SET username_encrypted = ?, password_encrypted = ?, msgid = CASE WHEN msgid = 0 THEN -1 ELSE msgid END WHERE telegramid = ?`,
        [encrypt(username), encrypt(password), telegramId]
    );
}

const getUntisCredentials = async (connection, telegramId, msgId = 0) => {
    const [rows] = await connection.query(
        `SELECT username_encrypted, password_encrypted, msgid FROM users WHERE telegramid = ?`,
        [telegramId]
    );

    if (!rows[0]) {
        return null;
    }

    if (rows[0].username_encrypted && rows[0].password_encrypted) {
        return {
            username: decrypt(rows[0].username_encrypted),
            password: decrypt(rows[0].password_encrypted)
        };
    }

    const fallbackMsgId = msgId || rows[0].msgid;
    if (!fallbackMsgId || fallbackMsgId <= 0) {
        return null;
    }

    try {
        const sentMessage = await bot.sendMessage(dataChannel, '.', { reply_to_message_id: fallbackMsgId });
        await bot.deleteMessage(dataChannel, sentMessage.message_id);
        const parsedData = JSON.parse(sentMessage.reply_to_message.text);
        const username = decrypt(parsedData.username);
        const password = decrypt(parsedData.pass);
        await saveUntisCredentials(connection, telegramId, username, password);
        return { username, password };
    } catch (error) {
        return null;
    }
}

const Lang = async (chatId, msg) => {
    bot.sendMessage(chatId, `Select a language:`, {
        chat_id: chatId,
        message_id: msg.message_id,
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '🇷🇺RU', callback_data: 'RU' },
                    { text: '🇩🇪DE', callback_data: 'DE' },
                    { text: '🇬🇧EN', callback_data: 'EN' },
                ],
                menuButton(en)
            ]
        }
    });
}

const formatDate = (date) => {
    let dateStr = date.toString();

    let day = dateStr.slice(6, 8);
    let month = dateStr.slice(4, 6);
    let year = dateStr.slice(2, 4);

    return `${day}.${month}.${year}`;
}

const menu = async (lang, chatId, msg) => {
    const params = chatId === owner ? { chat_id: chatId, message_id: msg.message_id, reply_markup: { inline_keyboard: [[{ text: `${lang.menu.buttons.timetable}`, callback_data: 'timetable' }, { text: `${lang.menu.buttons.homework}`, callback_data: 'homework' }], [{ text: `${lang.menu.buttons.profile}`, callback_data: 'UntisData' }, { text: `${lang.menu.buttons.settings}`, callback_data: 'settings' }], [{ text: `🛡Админ панель`, callback_data: 'admin' }]] } } : { chat_id: chatId, message_id: msg.message_id, reply_markup: { inline_keyboard: [[{ text: `${lang.menu.buttons.timetable}`, callback_data: 'timetable' }, { text: `${lang.menu.buttons.homework}`, callback_data: 'homework' }], [{ text: `${lang.menu.buttons.profile}`, callback_data: 'UntisData' }, { text: `${lang.menu.buttons.settings}`, callback_data: 'settings' }]] } }
    bot.sendMessage(chatId, `${lang.menu.welcome.replace('{{firstName}}', msg.chat.first_name)}`, params)
}
const ShowTimetable = async (lang, currentView, username, password, chatId, msg, currentDate, date, timestamp, msgId) => {
    try {
        const timetable = currentView === 'day' ? await getTimetableForDay(chatId, username, password, date) : await getTimetableForWeek(username, password, date);
        if (timetable === 'LoginFailed') {
            bot.sendMessage(chatId, lang.errors.login, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        menu(lang)
                    ]
                }
            });
            const connection = await mysql.createConnection(dbConfig);
            await clearUntisCredentials(connection, chatId);
            connection.end()
            return
        }
        timetable.sort((a, b) => a.startTime - b.startTime);
        const startDate = date
        const endDate = currentView === 'week' ? dateTools.endOfWeek(new Date(), { weekStartsOn: 1 }) : currentDate;
        const formattedTimetable = formatTimetable(lang, timetable, currentView, startDate, endDate);
        bot.sendMessage(chatId, formattedTimetable, {
            chat_id: chatId,
            message_id: msg.message_id,
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: currentView === 'day' ? `${lang.timetable.buttons.week_view}` : `${lang.timetable.buttons.day_view}`, callback_data: `toggle_view:${timestamp}` },
                        { text: `${lang.timetable.buttons.prev}`, callback_data: `prev:${timestamp}` },
                        { text: `${lang.timetable.buttons.next}`, callback_data: `next:${timestamp}` },
                    ],
                    menuButton(lang)
                ]
            }
        });
    } catch (e) {
        if (e.name === 'TypeError') {
            bot.sendMessage(chatId, lang.timetable.error.replace('{{date}}', `${date}`), {
                chat_id: chatId,
                message_id: msg.message_id,
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: currentView === 'day' ? `${lang.timetable.buttons.week_view}` : `${lang.timetable.buttons.day_view}`, callback_data: `toggle_view:${timestamp}` },
                            { text: `${lang.timetable.buttons.prev}`, callback_data: `prev:${timestamp}` },
                            { text: `${lang.timetable.buttons.next}`, callback_data: `next:${timestamp}` },
                        ],
                        menuButton(lang)
                    ]
                }
            })
        } else {
            bot.sendMessage(errChannel, `ERROR:\nuser:${chatId}\n${e}`)
        }
    }
}

const getTimetableForDay = async (chatId, username, pass, date) => {
    const untis = new api.WebUntis(school, username, pass, domain);
    try {
        await untis.login();
    } catch (e) {
        bot.sendMessage(errChannel, `ERROR login:\nuser: ${chatId}\n${e}`)
        return 'LoginFailed'
    }
    try {
        return await untis.getOwnTimetableFor(date)
    } catch (e) {
        bot.sendMessage(errChannel, `ERROR:\nuser: ${chatId}\n${e}`)
        return
    }
};

const getTimetableForWeek = async (username, pass, date) => {
    return ['no', 'week']
};

const formatTime = (time) => {
    const hours = Math.floor(time / 100);
    const minutes = time % 100;
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
};

const formatTimetable = (lang, timetable, view = `day`, startDate) => {
    4
    let result
    if (view === `day`) {
        result = `${lang.timetable.header} ${startDate.toDateString() === new Date().toDateString() ? `${lang.timetable.today}` : startDate.toLocaleDateString()}\n\n`;
        if (timetable.length === 0) {
            result += `${lang.timetable.no_lessons}`;
        } else {
            timetable.forEach(entry => {
                const startTime = formatTime(entry.startTime);
                const endTime = formatTime(entry.endTime);
                const getTeachers = () => {
                    let count = 0;
                    let result = ``;
                    entry.te.forEach(te => {
                        count += 1;
                        if (count > 1) {
                            result += `, `;
                        }
                        result += `${te.longname}(${te.name})`;
                    });
                    return result;
                };
                const teacher = entry.te[0] ? getTeachers() : '-';
                const subject = entry.su[0] ? `${entry.su[0].longname}(${entry.su[0].name})` : '-';
                const room = entry.ro[0] ? `${entry.ro[0].longname}(${entry.ro[0].name})` : '-';
                const status = entry.code === 'cancelled' ? `${lang.timetable.canceled}` : `${lang.timetable.active}`;
                result += `${startTime}-${endTime}\n${lang.timetable.lesson.teacher} ${teacher}\n${lang.timetable.lesson.subject} ${subject}\n${lang.timetable.lesson.room} ${room}\n${lang.timetable.lesson.status} ${status}\n-----------------------------\n`;
            });
        }
    } else if (view === 'week') {
        result = `${lang.timetable.week.unavailable}`
    }
    return result;
};

const CheckCanceles = async () => {
    try {
        const connection = await mysql.createConnection(dbConfig);
        const [results] = await connection.query(
            `SELECT telegramid, msgid, notif, lang FROM users WHERE telegramid`
        );
        for (const user of results) {
            const msgid = user.msgid
            if (user.notif === 'yes') {
                const credentials = await getUntisCredentials(connection, user.telegramid, msgid);
                if (!credentials) {
                    continue;
                }
                const { username, password } = credentials;
                const userLang = user.lang === 'EN' ? en : user.lang === 'RU' ? ru : de
                try {
                    const untis = new api.WebUntis(school, username, password, domain);
                    await untis.login()
                    const dates = [1, 2].map(offset => {
                        const date = new Date();
                        date.setDate(date.getDate() + offset);
                        return date;
                    });
                    const data = (await Promise.all(dates.map(date => untis.getOwnTimetableFor(date)))).flat();
                    const getCanceles = async () => {
                        const canceledLessons = data.filter(lesson => lesson.code === 'canceled');
                        const irregularLessons = data.filter(lesson => lesson.code === 'irregular');

                        const canceledResult = canceledLessons.map(lesson => {
                            const teachers = lesson.te.map(teacher => ({
                                shortName: teacher.name,
                                fullName: teacher.longname
                            }));

                            const rooms = lesson.ro.map(room => ({
                                shortName: room.name,
                                fullName: room.longname
                            }));

                            const subjects = lesson.su.map(subject => ({
                                shortName: subject.name,
                                fullName: subject.longname
                            }));

                            return {
                                startTime: lesson.startTime,
                                endTime: lesson.endTime,
                                teachers: teachers,
                                rooms: rooms,
                                subjects: subjects,
                                date: lesson.date
                            };
                        });

                        const irregularResult = irregularLessons.map(lesson => {
                            const teachers = lesson.te.map(teacher => ({
                                shortName: teacher.name,
                                fullName: teacher.longname
                            }));

                            const rooms = lesson.ro.map(room => ({
                                shortName: room.name,
                                fullName: room.longname
                            }));

                            const subjects = lesson.su.map(subject => ({
                                shortName: subject.name,
                                fullName: subject.longname
                            }));

                            return {
                                startTime: lesson.startTime,
                                endTime: lesson.endTime,
                                teachers: teachers,
                                rooms: rooms,
                                subjects: subjects,
                                date: lesson.date
                            };
                        });
                        if (!prevData[user.telegramid]) {
                            prevData[user.telegramid] = { canceled: {}, irregular: {} }
                        }
                        canceledResult.forEach((lesson) => {
                            if (!prevData[user.telegramid].canceled[`${lesson.date}(${lesson.startTime})`]) {
                                prevData[user.telegramid].canceled[`${lesson.date}(${lesson.startTime})`] = true;
                                let i = 0
                                let data = ''
                                lesson.teachers.forEach((teacher) => {
                                    i++
                                    data += `${teacher.fullName}(${teacher.shortName})${i === lesson.teachers.length ? '' : ', '}`
                                })
                                bot.sendMessage(user.telegramid, `${userLang.notifications.canceled.replace('{lesson.date}', formatDate(lesson.date)).replace('{lesson.startTime}', formatTime(lesson.startTime)).replace('{lesson.endTime}', formatTime(lesson.endTime)).replace('{lesson.subjects[0].fullName}', lesson.subjects[0].fullName).replace('{lesson.subjects[0].shortName}', lesson.subjects[0].shortName).replace('{data}', data).replace('{lesson.rooms[0].fullName}', lesson.rooms[0].fullName).replace('{lesson.rooms[0].shortName}', lesson.rooms[0].shortName)}`, { parse_mode: "Markdown" })
                            }
                        });
                        irregularResult.forEach((lesson) => {
                            if (!prevData[user.telegramid].irregular[`${lesson.date}(${lesson.startTime})`]) {
                                prevData[user.telegramid].irregular[`${lesson.date}(${lesson.startTime})`] = true;
                                let i = 0
                                let data = ''
                                lesson.teachers.forEach((teacher) => {
                                    i++
                                    data += `${teacher.fullName}(${teacher.shortName})${i === lesson.teachers.length ? '' : ', '}`
                                })
                                bot.sendMessage(user.telegramid, `${userLang.notifications.substit.replace('{lesson.date}', formatDate(lesson.date)).replace('{lesson.startTime}', formatTime(lesson.startTime)).replace('{lesson.endTime}', formatTime(lesson.endTime)).replace('{lesson.subjects[0].fullName}', lesson.subjects[0].fullName).replace('{lesson.subjects[0].shortName}', lesson.subjects[0].shortName).replace('{data}', data).replace('{lesson.rooms[0].fullName}', lesson.rooms[0].fullName).replace('{lesson.rooms[0].shortName}', lesson.rooms[0].shortName)}`, { parse_mode: "Markdown" })
                            }
                        });
                    }
                    await getCanceles()
                } catch (e) {
                    bot.sendMessage(errChannel, `Error:\n${e.message}`)
                    await clearUntisCredentials(connection, user.telegramid);
                    continue
                }
            }
        }
        connection.end()
    } catch (e) {

    } finally {
        return
    }
}

ensureUsersTable()
    .then(() => {
        CheckCanceles()
        setInterval(CheckCanceles, 3600000);
    })
    .catch((error) => {
        console.error(`ERROR DB INIT:\n${error.message}\n${error.stack}`);
        bot.sendMessage(errChannel, `ERROR DB INIT:\n${error.message}\n${error.stack}`)
            .finally(() => process.exit(1));
    });
setInterval(() => Object.assign(prevData, {}), 86400000)
// on messages
bot.on('message', async (msg) => {
    if (config.onlyOwner && msg.chat.id !== owner) {
        return
    }
    const currentDate = new Date();
    const currentTimestamp = Date.now()
    const chatId = msg.chat.id;
    if (isChanging.includes(chatId)) {
        return
    }
    let lang;
    let userLang;

    if (msg.chat.type !== 'private') {
        return;
    }
    if (!msg.text) {
        return bot.sendMessage(chatId, 'Only text.')
    }
    let connection
    try {
        connection = await mysql.createConnection({
            host: config.host,
            user: config.user,
            password: config.password,
            database: config.dbname
        });
        try {
            const [results] = await connection.query(
                `SELECT * FROM users WHERE telegramid = ?`, [chatId]
            );

            if (results.length === 0) {
                await connection.query(
                    `INSERT INTO users (telegramid) VALUES (?)`, [chatId]
                );
            }
            const [DBinfo] = await connection.query(
                `SELECT lang FROM users WHERE telegramid = ?`, [chatId]
            );
            lang = DBinfo[0]?.lang;
            if (lang === null) {
                if (/^\/lang( (.+))?$/.test(msg.text)) {
                    Lang(chatId, msg)
                } else {
                    bot.sendMessage(chatId, `Bitte wählen Sie eine Sprache aus - /lang.\n\nПожалуйста выберите язык - /lang.\n\nPlease select a language - /lang.`);
                }
            } else {
                userLang = lang === 'RU' ? ru : lang === 'EN' ? en : lang === 'DE' ? de : null;
                if (/^\/lang( (.+))?$/.test(msg.text)) {
                    Lang(chatId, msg)
                } else if (/^\/start(  (.+))?$/.test(msg.text)) {
                    menu(userLang, chatId, msg)
                } else if (/^\/timetable( (.+))?$/.test(msg.text)) {
                    let params = msg.text.match(/^\/timetable( (.+))?$/);
                    if (params && params[2]) {
                        params = params[2];
                    } else {
                        params = false;
                    }
                    try {
                        const [results] = await connection.query(
                            `SELECT view, msgid FROM users WHERE telegramid = ?`, [chatId]
                        );
                        if (results.length > 0) {
                            const view = results[0].view
                            const msgId = results[0].msgid
                            const credentials = await getUntisCredentials(connection, chatId, msgId);
                            if (!credentials) {
                                bot.sendMessage(chatId, `${userLang.errors.untis_credentials_required}`)
                            } else {
                                const { username, password } = credentials;
                                ShowTimetable(userLang, view, username, password, chatId, msg, currentDate, new Date(currentTimestamp), currentTimestamp, msgId)
                            }
                        } else {
                            bot.sendMessage(chatId, `${userLang.errors.user_not_found}`);
                        }
                    } catch (error) {
                        bot.sendMessage(chatId, `⛔️${userLang.errors.fetch_timetable}. ${error.message}`);
                        bot.sendMessage(errChannel, `ERROR:\nuser:${chatId}\n${error}`)
                    }
                } else if (/^\/donate( (.+))?$/.test(msg.text)) {
                    const params = msg.text.match(/^\/donate( (.+))?$/);
                    let amount = 1
                    if (params && params[2]) {
                        if (!isNaN(+params[2])) {
                            if (+params[2] < 100001) {
                                amount = +params[2]
                            } else {
                                amount = 100000
                                s
                            }
                        }
                    }
                    const info = {
                        chatId: msg.chat.id,
                        title: 'Donation',
                        description: `Donation ${amount} star(s) to Untis`,
                        payload: `donation_${Date.now()}`,
                        provider_token: '',
                        currency: 'XTR',
                        prices: [
                            {
                                label: 'Donate to Untis Pro Max',
                                amount: amount,
                            }
                        ],
                    };
                    bot.sendInvoice(info.chatId, info.title, info.description, info.payload, info.provider_token, info.currency, JSON.stringify(info.prices));
                } else if (msg.text.toLowerCase() === 'menu' || msg.text.toLowerCase() === 'меню' || msg.text.toLowerCase() === 'menü') {
                    menu(userLang, chatId, msg)
                }
                else {
                    if (chatId !== owner) {
                        bot.sendMessage(chatId, `${userLang.general.nocommand}`, {
                            chat_id: chatId,
                            message_id: msg.message_id,
                            reply_markup: {
                                inline_keyboard: [
                                    menuButton(userLang)
                                ]
                            }
                        })
                    }
                }
            }
        } catch (error) {
            bot.sendMessage(chatId, `⛔️${error}`);
            bot.sendMessage(errChannel, `ERROR:\nuser:${chatId}\n${error}`)
        }
        if (chatId === owner) {
            if (/^\/getallusers( (.+))?$/.test(msg.text)) {
                let params = msg.text.match(/^\/getallusers( (.+))?$/);
                if (params && params[2]) {
                    params = params[2];
                } else {
                    params = false;
                }

                if (!params || params !== 'data') {
                    const [results] = await connection.query(
                        `SELECT id, telegramid FROM users`
                    );

                    const toShow = (results) => {
                        let result = ``;
                        results.forEach((user) => {
                            result += `${user.id}. [${user.telegramid}](tg://user?id=${user.telegramid})\n`;
                        });
                        return result || 'Пользователей нет.';
                    };

                    bot.sendMessage(owner, `*Все пользователи:* \n${toShow(results)}`, { parse_mode: 'Markdown' });
                } else if (params === 'data') {
                    const [results] = await connection.query(
                        `SELECT * FROM users ORDER BY id`
                    );

                    const toShow = (results) => {
                        let result = ``;
                        results.forEach((user) => {
                            const username = user.username || '-';
                            const msgid = user.msgid || '-'
                            const notif = user.notif.replace('no', 'выкл.').replace('yes', 'вкл.')
                            const lang = user.lang || '-';
                            result += `${user.id}. [${user.telegramid}](tg://user?id=${user.telegramid}) ${msgid} ${notif} ${lang}\n`;
                        });
                        return result || 'Пользователей нет.';
                    };

                    bot.sendMessage(owner, `*Все пользователи с их данными:* \nTG id|Message id|Уведомления|Язык\n\n${toShow(results)}`, { parse_mode: 'Markdown' });
                }
            } else if (/^\/sendall( (.+))?$/.test(msg.text)) {
                const messageToSend = msg.text.split(' ').slice(1).join(' ');
                const [results] = await connection.query(`SELECT telegramid FROM users`);
                if (!messageToSend || messageToSend === '') {
                    bot.sendMessage(owner, '*Введите сообщение для отправки всем пользователям:*', { parse_mode: 'Markdown' })
                    const on = async (msg) => {
                        if (msg.chat.id !== owner) return;
                        try {
                            results.forEach(user => {
                                if (user.telegramid !== owner) {
                                    try {
                                        bot.copyMessage(user.telegramid, owner, msg.message_id).catch((e) => bot.sendMessage(errChannel, `ERROR:\n${e}`));
                                    } catch (e) {
                                        bot.sendMessage(errChannel, `ERROR:\n${e}`)
                                    }
                                }
                            });
                            bot.sendMessage(owner, `Сообщение отправлено всем пользователям.`);
                            bot.removeListener('message', on);
                        } catch (error) {
                            bot.sendMessage(chatId, `${userLang.errors.unknown_error} ${error.message}`);
                            bot.sendMessage(errChannel, `ERROR:\nuser:${chatId}\n${error}`);
                            bot.removeListener('message', on);
                        }
                    }
                    bot.on('message', on)
                } else {
                    results.forEach(user => {
                        if (user.telegramid !== owner) {
                            try {
                                bot.sendMessage(user.telegramid, `${messageToSend.replace(/\\n/gi, '\n')}`, { parse_mode: "Markdown" }).catch((e) => bot.sendMessage(errChannel, `ERROR:\n${e}`));
                            } catch (e) {
                                bot.sendMessage(errChannel, `ERROR:\n${e}`)
                            }
                        }
                    });
                    bot.sendMessage(owner, `Сообщение отправлено всем пользователям.`);
                }
            }
        }
    } catch (error) {
        bot.sendMessage(chatId, `⛔️${error.message}`);
        bot.sendMessage(errChannel, `ERROR:\nuser:${chatId}\n${error}`)
    } finally {
        if (connection) {
            await connection.end();
        }
    }
});

// on callback

bot.on('callback_query', async (callbackQuery) => {
    if (config.onlyOwner && callbackQuery.message.chat.id !== owner) {
        return
    }
    let currentDate = new Date();
    let currentTimestamp = Date.now()
    const msg = callbackQuery.message;
    const chatId = msg.chat.id;
    let lang;
    let userLang;

    if (msg.chat.type !== 'private') {
        return
    }
    let connection
    try {
        connection = await mysql.createConnection({
            host: config.host,
            user: config.user,
            password: config.password,
            database: config.dbname
        });
        const [results] = await connection.query(
            `SELECT * FROM users WHERE telegramid = ?`, [chatId]
        );

        if (results.length === 0) {
            await connection.query(
                `INSERT INTO users (telegramid) VALUES (?)`, [chatId]
            );
        }
        const [DBinfo] = await connection.query(
            `SELECT lang FROM users WHERE telegramid = ?`, [chatId]
        );
        lang = DBinfo[0]?.lang;
        if (lang === null) {
            if (callbackQuery.data === 'RU') {
                await connection.query(
                    `UPDATE users SET lang = ? WHERE telegramid = ?`, [callbackQuery.data, chatId]
                );
                bot.sendMessage(chatId, `Установлен русский язык.`, {
                    parse_mode: "Markdown",
                    chat_id: chatId,
                    message_id: msg.message_id,
                    reply_markup: {
                        inline_keyboard: [
                            menuButton(ru)
                        ]
                    }
                });

            } else if (callbackQuery.data === 'DE') {
                await connection.query(
                    `UPDATE users SET lang = ? WHERE telegramid = ?`, [callbackQuery.data, chatId]
                );
                bot.sendMessage(chatId, `Die Sprache ist auf Deutsch eingestellt.`, {
                    parse_mode: "Markdown",
                    chat_id: chatId,
                    message_id: msg.message_id,
                    reply_markup: {
                        inline_keyboard: [
                            menuButton(de)
                        ]
                    }
                });
            } else if (callbackQuery.data === 'EN') {
                await connection.query(
                    `UPDATE users SET lang = ? WHERE telegramid = ?`, [callbackQuery.data, chatId]
                );
                bot.sendMessage(chatId, `The language is set to English.`, {
                    parse_mode: "Markdown",
                    chat_id: chatId,
                    message_id: msg.message_id,
                    reply_markup: {
                        inline_keyboard: [
                            menuButton(en)
                        ]
                    }
                });
            } else {
                bot.sendMessage(chatId, `Bitte wählen Sie eine Sprache aus - /lang.\n\nПожалуйста выберите язык - /lang.\n\nPlease select a language - /lang.`);
            }
            return
        } else {
            userLang = lang === 'RU' ? ru : lang === 'EN' ? en : lang === 'DE' ? de : null;
        }
        if (isChanging.includes(chatId)) {
            return bot.answerCallbackQuery(callbackQuery.id, { text: userLang.general.editDataFirst })
        }

        if (/^toggle_view:((.+))?$/.test(callbackQuery.data)) {
            const splited = callbackQuery.data.split(':')
            let date
            splited.forEach((entry) => {
                if (entry === 'toggle_view') {
                    return
                } else {
                    date = entry
                }
            });
            bot.deleteMessage(msg.chat.id, msg.message_id)
            try {
                const [results] = await connection.query(
                    `SELECT view, msgid FROM users WHERE telegramid = ?`, [chatId]
                );
                if (results.length > 0) {
                    const view = results[0].view
                    const msgId = results[0].msgid
                    const credentials = await getUntisCredentials(connection, chatId, msgId);
                    if (!credentials) {
                        bot.sendMessage(chatId, `${userLang.errors.untis_credentials_required}`)
                    } else {
                        NewView = view === 'day' ? 'week' : 'day';
                        const { username, password } = credentials;
                        ShowTimetable(userLang, NewView, username, password, chatId, msg, currentDate, new Date(currentTimestamp), currentTimestamp, msgId)
                        await connection.query(
                            `UPDATE users SET view = ? WHERE telegramid = ?`, [NewView, chatId]
                        );
                    }
                }
            } catch (error) {
                bot.sendMessage(chatId, `${userLang.errors.fetch_timetable} ${error.message}`);
                bot.sendMessage(errChannel, `ERROR:\nuser:${chatId}\n${error}`);
            }
        } else if (callbackQuery.data === 'timetable') {
            bot.deleteMessage(msg.chat.id, msg.message_id)
            try {
                const [results] = await connection.query(
                    `SELECT view, msgid FROM users WHERE telegramid = ?`, [chatId]
                );
                if (results.length > 0) {
                    const view = results[0].view
                    const msgId = results[0].msgid
                    const credentials = await getUntisCredentials(connection, chatId, msgId);
                    if (!credentials) {
                        bot.sendMessage(chatId, `${userLang.errors.untis_credentials_required}`)
                    } else {
                        const { username, password } = credentials;
                        ShowTimetable(userLang, view, username, password, chatId, msg, currentDate, new Date(currentTimestamp), currentTimestamp, msgId)
                    }
                }
            } catch (error) {
                bot.sendMessage(chatId, `${userLang.errors.fetch_timetable}. ${error.message}`);
                bot.sendMessage(errChannel, `ERROR:\nuser:${chatId}\n${error}`);
            }
        } else if (callbackQuery.data === 'menu') {
            bot.deleteMessage(msg.chat.id, msg.message_id)
            menu(userLang, chatId, msg)
        } else if (callbackQuery.data === 'RU') {
            await connection.query(
                `UPDATE users SET lang = ? WHERE telegramid = ?`, [callbackQuery.data, chatId]
            );
            bot.sendMessage(chatId, `Установлен русский язык.`, {
                parse_mode: "Markdown",
                chat_id: chatId,
                message_id: msg.message_id,
                reply_markup: {
                    inline_keyboard: [
                        menuButton(ru)
                    ]
                }
            });

        } else if (callbackQuery.data === 'DE') {
            await connection.query(
                `UPDATE users SET lang = ? WHERE telegramid = ?`, [callbackQuery.data, chatId]
            );
            bot.sendMessage(chatId, `Die Sprache ist auf Deutsch eingestellt.`, {
                parse_mode: "Markdown",
                chat_id: chatId,
                message_id: msg.message_id,
                reply_markup: {
                    inline_keyboard: [
                        menuButton(de)
                    ]
                }
            });
        } else if (callbackQuery.data === 'EN') {
            await connection.query(
                `UPDATE users SET lang = ? WHERE telegramid = ?`, [callbackQuery.data, chatId]
            );
            bot.sendMessage(chatId, `The language is set to English.`, {
                parse_mode: "Markdown",
                chat_id: chatId,
                message_id: msg.message_id,
                reply_markup: {
                    inline_keyboard: [
                        menuButton(en)
                    ]
                }
            });
        } else if (callbackQuery.data === 'admin') {
            if (callbackQuery.from.id !== owner) {
                return
            } else {
                bot.sendMessage(owner, `*Добро пожаловать, админ!*\n\nЧто вы хотите сделать?`, {
                    parse_mode: "Markdown",
                    chat_id: chatId,
                    message_id: msg.message_id,
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: 'Пользователи', callback_data: 'users' },
                                { text: `Table users`, callback_data: 'users:data' },
                                { text: `Отправить всем.`, callback_data: 'sendall' }],
                            [{ text: 'Ошибки', url: 'https://t.me/c/2491197954/' }],
                            menuButton(userLang)
                        ]
                    }
                })
            }
        } else if (/^next:((.+))?$/.test(callbackQuery.data)) {
            const splited = callbackQuery.data.split(':')
            let date
            splited.forEach((entry) => {
                if (entry === 'next') {
                    return
                } else {
                    date = entry
                }
            });
            bot.deleteMessage(chatId, msg.message_id)
            try {
                const [results] = await connection.query(
                    `SELECT view, msgid FROM users WHERE telegramid = ?`, [chatId]
                );
                if (results.length > 0) {
                    const view = results[0].view
                    const msgId = results[0].msgid
                    const credentials = await getUntisCredentials(connection, chatId, msgId);
                    if (!credentials) {
                        bot.sendMessage(chatId, `${userLang.errors.untis_credentials_required}`)
                    } else {
                        const { username, password } = credentials;
                        const getPlus = () => {
                            if (view === 'day') {
                                return +date + 86400000
                            } else {
                                return +date + 86400000 * 7
                            }
                        }
                        const datePlus = getPlus()
                        ShowTimetable(userLang, view, username, password, chatId, msg, currentDate, new Date(datePlus), datePlus, msgId)
                    }
                }
            } catch (error) {
                bot.sendMessage(chatId, `${userLang.errors.fetch_timetable} ${error.message}`);
                bot.sendMessage(errChannel, `ERROR:\nuser:${chatId}\n${error}`);
            }
        } else if (/^prev:((.+))?$/.test(callbackQuery.data)) {
            const splited = callbackQuery.data.split(':')
            let date
            splited.forEach((entry) => {
                if (entry === 'prev') {
                    return
                } else {
                    date = entry
                }
            });
            bot.deleteMessage(chatId, msg.message_id)
            try {
                const [results] = await connection.query(
                    `SELECT view, msgid FROM users WHERE telegramid = ?`, [chatId]
                );
                if (results.length > 0) {
                    const view = results[0].view
                    const msgId = results[0].msgid
                    const credentials = await getUntisCredentials(connection, chatId, msgId);
                    if (!credentials) {
                        bot.sendMessage(chatId, `${userLang.errors.untis_credentials_required}`)
                    } else {
                        const { username, password } = credentials;
                        const getMinus = () => {
                            if (view === 'day') {
                                return +date - 86400000
                            } else {
                                return +date - 86400000 * 7
                            }
                        }
                        const dateMinus = getMinus()
                        ShowTimetable(userLang, view, username, password, chatId, msg, currentDate, new Date(dateMinus), dateMinus, msgId)
                    }
                }
            } catch (error) {
                bot.sendMessage(chatId, `${userLang.errors.fetch_timetable} ${error.message}`);
                bot.sendMessage(errChannel, `ERROR:\nuser:${chatId}\n${error}`);
            }
        } else if (/^settings((.+))?$/.test(callbackQuery.data)) {
            try {
                const [results] = await connection.query(
                    `SELECT msgid, lang, notif FROM users WHERE telegramid = ?`, [chatId]
                );

                if (results.length > 0) {
                    const msgid = results[0].msgid
                    const langid = results[0].lang
                    const isnotif = results[0].notif
                    let data
                    const credentials = await getUntisCredentials(connection, chatId, msgid);
                    if (!credentials) {
                        data = `${userLang.settings.no_info}`
                    } else {
                        let passLength = credentials.password.length
                        let pass = ''
                        while (passLength > 0) {
                            pass += '\\*';
                            passLength--
                        }
                        data = `${credentials.username}, ${pass}`
                        try {
                            const untis = new api.WebUntis(school, credentials.username, credentials.password, domain);
                            await untis.login()
                        } catch (e) {
                            data = `${userLang.settings.no_info}`
                            await clearUntisCredentials(connection, chatId);
                        }
                    }
                    const lang = langid === 'RU' ? '🇷🇺Русский' : langid === 'EN' ? '🇬🇧English' : langid == 'DE' ? '🇩🇪Deutsch' : '❌No info.'
                    const notif = isnotif === 'yes' ? `${userLang.settings.on}` : `${userLang.settings.off}`
                    bot.sendMessage(chatId, `*${userLang.settings.header}*\n\n${userLang.settings.untis_data} ${data}\n${userLang.settings.language} ${lang}\n${userLang.settings.notifications} ${notif}`, {
                        parse_mode: "Markdown",
                        chat_id: chatId,
                        message_id: msg.message_id,
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    { text: '🌎Language', callback_data: 'lang' },
                                    { text: `${userLang.settings.buttons.notifications}`, callback_data: 'notif' },
                                    { text: `${userLang.settings.buttons.untis_data}`, callback_data: 'UntisData' }],
                                menuButton(userLang)
                            ]
                        }
                    });
                }
            } catch (error) {
                bot.sendMessage(chatId, `${userLang.errors.fetch_timetable} ${error.message}`);
                bot.sendMessage(errChannel, `ERROR:\nuser:${chatId}\n${error}`);
            }
        } else if (callbackQuery.data === 'lang') {
            Lang(chatId, msg)
        } else if (callbackQuery.data === 'notif') {
            try {
                const [results] = await connection.query(
                    `SELECT notif FROM users WHERE telegramid = ?`, [chatId]
                );

                if (results.length > 0) {
                    const isnotifid = results[0].notif
                    const isnotif = () => {
                        if (isnotifid === 'yes') {
                            return true
                        } else {
                            return false
                        }
                    };
                    if (!isnotif()) {
                        bot.sendMessage(chatId, `${userLang.settings.notifications_prompt.enable}`, {
                            parse_mode: "Markdown",
                            chat_id: chatId,
                            message_id: msg.message_id,
                            reply_markup: {
                                inline_keyboard: [
                                    [
                                        { text: `${userLang.settings.notifications_prompt.buttons.enable}`, callback_data: 'notif:on' }
                                    ],
                                    menuButton(userLang)
                                ]
                            }
                        });
                    } else {
                        bot.sendMessage(chatId, `${userLang.settings.notifications_prompt.disable}`, {
                            parse_mode: "Markdown",
                            chat_id: chatId,
                            message_id: msg.message_id,
                            reply_markup: {
                                inline_keyboard: [
                                    [
                                        { text: `${userLang.settings.notifications_prompt.buttons.disable}`, callback_data: 'notif:off' }
                                    ],
                                    menuButton(userLang)
                                ]
                            }
                        });
                    }
                }
            } catch (error) {
                bot.sendMessage(chatId, `${userLang.errors.info} ${error.message}`);
                bot.sendMessage(errChannel, `ERROR:\nuser:${chatId}\n${error}`);
            }
        } else if (callbackQuery.data === 'UntisData') {
            try {
                const [results] = await connection.query(
                    `SELECT msgid FROM users WHERE telegramid = ?`, [chatId]
                );

                if (results.length > 0) {
                    const msgid = results[0].msgid
                    let data = {}
                    const credentials = await getUntisCredentials(connection, chatId, msgid);
                    if (!credentials) {
                        data.isInfo = false
                        data.msgid = msgid
                    } else {
                        data.isInfo = true
                        let passLength = credentials.password.length
                        data.uname = credentials.username;
                        data.upass = credentials.password;
                        let pass = ''
                        while (passLength > 0) {
                            pass += '\\*';
                            passLength--
                        }
                        data.pass = pass
                    }

                    bot.deleteMessage(chatId, msg.message_id)
                    let message
                    let inline
                    if (data.isInfo) {
                        let isValid = true
                        try {
                            const untis = new api.WebUntis(school, data.uname, data.upass, domain);
                            await untis.login()
                        } catch (e) {
                            isValid = false
                            await clearUntisCredentials(connection, chatId);
                            return
                        }
                        const status = isValid ? userLang.untis_data.valid : userLang.untis_data.invalid
                        message = `${userLang.untis_data.head}${userLang.untis_data.isInfo.replace('{{data.uname}}', data.uname).replace('{{data.pass}}', data.pass)}${status}`
                        inline = {
                            parse_mode: "Markdown",
                            chat_id: chatId,
                            message_id: msg.message_id,
                            reply_markup: {
                                inline_keyboard: [
                                    [
                                        { text: `${userLang.untis_data.ChangeData}`, callback_data: 'ChangeData' },
                                        { text: `${userLang.untis_data.RmData}`, callback_data: 'RmData' }
                                    ],
                                    menuButton(userLang)
                                ]
                            }
                        }
                    } else {
                        message = `${userLang.untis_data.head}${userLang.untis_data.noInfo}`
                        inline = {
                            parse_mode: "Markdown",
                            chat_id: chatId,
                            message_id: msg.message_id,
                            reply_markup: {
                                inline_keyboard: [
                                    [
                                        { text: `${userLang.untis_data.ChangeData}`, callback_data: 'ChangeData' },
                                    ],
                                    menuButton(userLang)
                                ]
                            }
                        }
                    }
                    bot.sendMessage(chatId, message, inline);
                }
            } catch (error) {
                bot.sendMessage(chatId, `${userLang.errors.fetch_timetable} ${error.message}`);
                bot.sendMessage(errChannel, `ERROR:\nuser:${chatId}\n${error}`);
            }
        } else if (/^notif:((.+))?$/.test(callbackQuery.data)) {
            const splited = callbackQuery.data.split(':')
            let isOn
            splited.forEach((entry) => {
                if (entry === 'notif') {
                    return
                } else {
                    if (entry === 'on') {
                        isOn = 'yes'
                    } else {
                        isOn = 'no'
                    }
                }
            });
            try {
                await connection.query(
                    `UPDATE users SET notif = ? WHERE telegramid = ?`, [isOn, chatId]
                );
                bot.deleteMessage(chatId, msg.message_id)
                bot.sendMessage(chatId, `${userLang.general.success}`, {
                    chat_id: chatId,
                    message_id: msg.message_id,
                    reply_markup: {
                        inline_keyboard: [
                            menuButton(userLang)
                        ]
                    }
                });
            } catch (error) {
                bot.sendMessage(chatId, `${userLang.errors.fetch_timetable} ${error.message}`);
                bot.sendMessage(errChannel, `ERROR:\nuser:${chatId}\n${error}`);
            }
        } else if (callbackQuery.data === 'ChangeData') {
            if (isChanging.includes(chatId)) {
                return
            }
            isChanging.push(chatId)
            const parse_mode = { parse_mode: 'Markdown' }
            bot.sendMessage(chatId, `${userLang.untis_data.login}`, parse_mode)
            let username = false
            let password = false
            const on = async (msg) => {
                if (msg.chat.id !== chatId) return;
                if (!username) {
                    username = msg.text;
                    bot.sendMessage(chatId, `${userLang.untis_data.pass}`, parse_mode)
                } else if (!password) {
                    password = msg.text
                    bot.deleteMessage(chatId, msg.message_id)
                    const untis = new api.WebUntis(school, username, password, domain);
                    let isValid = true
                    try {
                        await untis.login();
                    } catch (e) {
                        bot.sendMessage(errChannel, `ERROR login:\nuser: ${chatId}\n${e}`)
                        isValid = false
                    } finally {
                        if (!isValid) {
                            const index = isChanging.indexOf(chatId)
                            if (index > -1) {
                                isChanging.splice(index, 1)
                            }
                            bot.sendMessage(chatId, `${userLang.errors.ChangeData}`, {
                                parse_mode: "Markdown",
                                reply_markup: {
                                    inline_keyboard: [
                                        menuButton(userLang)
                                    ]
                                }
                            })
                        }
                        else {
                            connection = await mysql.createConnection(dbConfig);
                            try {
                                await saveUntisCredentials(connection, chatId, username, password);
                                let pass = ''
                                let passLength = password.length
                                while (passLength > 0) {
                                    pass += '\\*';
                                    passLength--
                                }
                                bot.sendMessage(chatId, `${userLang.untis_data.success.replace('{{username}}', username).replace('{{pass}}', pass)}`, parse_mode);
                                bot.removeListener('message', on);
                                connection.end()
                                const index = isChanging.indexOf(chatId)
                                if (index > -1) {
                                    isChanging.splice(index, 1)
                                }
                            } catch (error) {
                                bot.sendMessage(chatId, `${userLang.errors.unknown_error} ${error.message}`);
                                bot.sendMessage(errChannel, `ERROR:\nuser:${chatId}\n${error}`);
                                connection.end()
                            }
                        }
                    }
                }
            }
            bot.on('message', on);
        } else if (callbackQuery.data === 'RmData') {
            const inline = {
                chat_id: chatId,
                message_id: msg.message_id,
                reply_markup: {
                    inline_keyboard: [
                        menuButton(userLang)
                    ]
                }
            }
            try {
                connection = await mysql.createConnection(dbConfig);
                await clearUntisCredentials(connection, chatId);
                bot.sendMessage(chatId, `${userLang.general.success}`, inline)
            } catch (error) {
                bot.sendMessage(chatId, `⛔️${error.message}`);
                bot.sendMessage(errChannel, `ERROR:\nuser:${chatId}\n${error}`)
            }
        } else if (callbackQuery.data === 'homework') {
            try {
                const [results] = await connection.query(
                    `SELECT msgid FROM users WHERE telegramid = ?`, [chatId]
                );

                if (results.length > 0) {
                    const msgid = results[0].msgid;
                    const credentials = await getUntisCredentials(connection, chatId, msgid);
                    if (!credentials) {
                        return bot.sendMessage(chatId, `${userLang.errors.untis_credentials_required}`)
                    }
                    let untis
                    try {
                        untis = new api.WebUntis(school, credentials.username, credentials.password, domain);
                        await untis.login();
                    } catch (e) {
                        bot.sendMessage(chatId, userLang.errors.login, {
                            parse_mode: 'Markdown',
                            reply_markup: {
                                inline_keyboard: [
                                    menu(lang)
                                ]
                            }
                        });
                        bot.sendMessage(errChannel, `ERROR login:\nuser: ${chatId}\n${e}`)
                        await clearUntisCredentials(connection, chatId);
                        return
                    }
                    const result = await untis.getHomeWorksFor(new Date(currentTimestamp), new Date(currentTimestamp + 86400000 * 7));
                    let data = '';
                    result.homeworks.forEach(hw => {
                        const LessonIndex = result.lessons.findIndex(obj => obj.id === hw.lessonId);
                        const Lesson = result.lessons[LessonIndex].subject;
                        const due = hw.dueDate
                        const date = hw.date
                        data += `${userLang.homeworks.lesson} ${Lesson}\n${formatDate(date)} - ${formatDate(due)}\n\n_${hw.text}_\n-----------------------------\n`;
                    });
                    bot.sendMessage(chatId, `*${userLang.homeworks.header}*\n\n${data}`, {
                        parse_mode: "Markdown",
                        chat_id: chatId,
                        message_id: msg.message_id,
                        reply_markup: {
                            inline_keyboard: [
                                menuButton(userLang)
                            ]
                        }
                    });
                }
            } catch (error) {
                bot.sendMessage(chatId, `${userLang.errors.fetch_timetable} ${error.message}`);
                bot.sendMessage(errChannel, `ERROR:\nuser:${chatId}\n${error}`);
            }
        }
    } finally {
        if (connection) {
            await connection.end();
        }
    }
    bot.on('pre_checkout_query', (query) => {
        console.log('Получен pre_checkout_query:', query);
        bot.answerPreCheckoutQuery(query.id, true)
            .then(() => console.log('Запрос pre_checkout подтвержден.'))
            .catch((err) => console.error('Ошибка pre_checkout:', err));
    });

    bot.on('successful_payment', (msg) => {
        const payment = msg.successful_payment;

        console.log('Успешная оплата:', payment);

        bot.sendMessage(
            msg.chat.id,
            `*🙏Thanks for your donation!*\n😊We sent a message about it to our channel @UntisBotWG.\n📝Payment details: _${payment.total_amount / 100} ${payment.currency}_`
        );
    });
});
