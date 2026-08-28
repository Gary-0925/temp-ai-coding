<?php
session_start();
error_reporting(E_ALL);
ini_set('display_errors', 1);
date_default_timezone_set('Asia/Shanghai');

if (file_exists('visit_log.php')) {
	require_once 'visit_log.php';
}

header("Content-Type:text/html;charset=utf-8");

if (!isset($_SESSION['uid'])) {
	header("Location: https://lmtoj.cn/login");
	exit;
}

require_once __DIR__ . '/database.php';
$conn = db();
$conn->set_charset("utf8mb4");

function getAchievementScore($certType, $certLevel)
{
	if (empty($certType) || $certLevel <= 0) return 0;
	$validTypes = ['OI', 'ICPC'];
	if (!in_array(strtoupper($certType), $validTypes)) return 0;
	$map = [3 => 2, 4 => 3, 5 => 5, 6 => 10, 7 => 13, 8 => 15, 9 => 18, 10 => 20];
	return $map[$certLevel] ?? 0;
}

function getColorByTotalScore($totalScore, $isAdmin)
{
	if ($isAdmin) return '#8e44ad';
	if ($totalScore < 0) return '#8b6b4d';
	if ($totalScore <= 10) return '#b0a8a0';
	if ($totalScore <= 20) return '#4a90d9';
	if ($totalScore <= 45) return '#28a745';
	if ($totalScore <= 65) return '#e67e22';
	return '#e74c3c';
}

function getUserColor($user, $login_uid, $myShowColorful = 1)
{
	$base = (int) ($user['base_credit'] ?? 10);
	$achieve = min(getAchievementScore($user['cert_type'] ?? '', (int) ($user['cert_level'] ?? 0)), 20);
	$practice = min((int) ($user['practice_score'] ?? 0), 20);
	$contribute = min((int) ($user['contribute_score'] ?? 0), 30);
	$contest = min((int) ($user['contest_score'] ?? 0), 20);
	$valuation = (int) ($user['valuation'] ?? 0);
	$isBrown = ($valuation === -1);
	$total = $isBrown ? -1 : ($base + $achieve + $practice + $contribute + $contest);
	$admin = (int) ($user['admin'] ?? 0);
	$color = getColorByTotalScore($total, $admin);

	$targetColorful = ($user['username_color'] ?? 'auto') === 'beautiful' &&
		($achieve >= 20 || $practice >= 30 || $contribute >= 30 || $contest >= 20);
	$isColorful = false;
	if ($user['uid'] == $login_uid) {
		$isColorful = $targetColorful;
	} else {
		$isColorful = $targetColorful && $myShowColorful;
	}
	return ['color' => $color, 'isColorful' => $isColorful];
}

$conn->query("CREATE TABLE IF NOT EXISTS lolmtoj_rooms (
	id INT AUTO_INCREMENT PRIMARY KEY,
	room_code VARCHAR(16) NOT NULL UNIQUE,
	host_uid INT NOT NULL,
	title VARCHAR(100) NOT NULL,
	status VARCHAR(20) DEFAULT 'waiting',
	max_players INT DEFAULT 4,
	game_state LONGTEXT,
	version INT DEFAULT 1,
	updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

$conn->query("CREATE TABLE IF NOT EXISTS lolmtoj_room_players (
	id INT AUTO_INCREMENT PRIMARY KEY,
	room_id INT NOT NULL,
	uid INT NOT NULL,
	general_id INT DEFAULT 0,
	is_ready TINYINT DEFAULT 0,
	joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
	UNIQUE KEY uk_room_user (room_id, uid),
	INDEX (room_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

$conn->query("CREATE TABLE IF NOT EXISTS lolmtoj_chat (
	id INT AUTO_INCREMENT PRIMARY KEY,
	room_id INT NOT NULL,
	uid INT NOT NULL,
	name VARCHAR(50) NOT NULL,
	msg VARCHAR(500) NOT NULL,
	created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
	INDEX (room_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

$conn->query("CREATE TABLE IF NOT EXISTS lolmtoj_game_records (
	id INT AUTO_INCREMENT PRIMARY KEY,
	room_id INT NOT NULL,
	uid INT NOT NULL,
	general_id INT NOT NULL,
	is_winner TINYINT DEFAULT 0,
	kills INT DEFAULT 0,
	created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
	INDEX(uid),
	INDEX(general_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

$login_uid = (int) $_SESSION['uid'];
$userRow = $conn->query("SELECT name, admin, sqadmin, avatar, show_colorful_names, 
	base_credit, valuation, username_color, cert_type, cert_level, practice_score,
	contribute_score, contest_score FROM users WHERE uid = {$login_uid} LIMIT 1")->fetch_assoc();

$is_admin = $userRow['admin'] ?? 0;
$login_name = $userRow['name'] ?? '英雄';
$myShowColorful = $userRow['show_colorful_names'] ?? 1;

$GENERALS_CONFIG = [
	1 => [
		'id' => 1,
		'name' => 'Ydch',
		'hp' => 4,
		'maxHp' => 4,
		'avatar' => '/upload/lolmtoj/1.png',
		'skills' => [
			['name' => '信心', 'type' => '锁定技', 'desc' => '准备阶段，若你拥有“信心”标记，你必须指定一名其他角色并将标记转移给该角色，该角色受到一点伤害；否则你获得“信心”标记，并恢复一点体力。'],
			['name' => '泄密', 'type' => '技能', 'desc' => '锁定技，出牌阶段限一次，若你拥有手牌，你必须指定一个拥有“信心”标记最多的角色，该角色获得你一张手牌。']
		]
	],
	2 => [
		'id' => 2,
		'name' => '六面体',
		'hp' => 4,
		'maxHp' => 4,
		'avatar' => '/upload/lolmtoj/2.png',
		'skills' => [
			['name' => '暴政', 'type' => '锁定技', 'desc' => '准备阶段，你进行判定，若不为红色，视为你打出一张【南蛮入侵】。']
		]
	],
	3 => [
		'id' => 3,
		'name' => 'Gary0',
		'hp' => 3,
		'maxHp' => 3,
		'avatar' => '/upload/lolmtoj/3.png',
		'skills' => [
			['name' => '瑞平', 'type' => '技能', 'desc' => '出牌阶段限一次，你可以指定一名角色，若该角色已有“瑞平”标记，其弃置两张手牌；否则其获得一个“瑞平”标记。'],
			['name' => '制牌', 'type' => '技能', 'desc' => '你可以指定一名拥有“瑞平”标记的角色并使用lycuim制牌，其失去所有瑞平标记，你将该角色所有手牌任意排列后将若干张（可为零）插入到牌堆顶，并获得其余牌。随后若你还未翻面，你翻面。']
		]
	],
	4 => [
		'id' => 4,
		'name' => '小猫娘FR',
		'hp' => 3,
		'maxHp' => 3,
		'avatar' => '/upload/lolmtoj/4.png',
		'skills' => [
			['name' => '撒娇', 'type' => '技能', 'desc' => '出牌阶段限一次，进行卖萌，场上所有角色（包括你）选择弃置两张手牌或受到一点伤害。'],
			['name' => '灌水', 'type' => '限定技', 'desc' => '限定技，你从其他所有玩家的手牌中任选至多四张获得，并弃置其余部分，随后你的回合直接结束（跳过弃牌阶段）。']
		]
	],
	5 => [
		'id' => 5,
		'name' => 'Rabo',
		'hp' => 3,
		'maxHp' => 3,
		'avatar' => '/upload/lolmtoj/5.png',
		'skills' => [
			['name' => '调教', 'type' => '技能', 'desc' => '出牌阶段限一次，你可以指定一名角色获得一个“小猫梁”标记。'],
			['name' => '控制', 'type' => '锁定技', 'desc' => '锁定技，至少有两个“小猫梁”标记的角色的回合被替换为你的回合，但该额外的回合内你无法使用【调教】，随后其仅失去所有“小猫梁”标记。']
		]
	],
	7 => [
		'id' => 7,
		'name' => 'zhoumurui',
		'hp' => 3,
		'maxHp' => 3,
		'avatar' => '/upload/lolmtoj/7.png',
		'skills' => [
			['name' => '暴论', 'type' => '技能', 'desc' => '出牌阶段限一次，你可以将一张【杀】当做任意一张锦囊牌使用，若此牌在结算时造成了伤害，防止此伤害。'],
			['name' => '自嘲', 'type' => '技能', 'desc' => '结束阶段，你可以重复从牌堆顶摸一张牌，直到手牌数达到X张（X为除你以外手牌最多的角色的手牌数）。']
		]
	]
];

function generateDeck()
{
	$deck = [];
	$rawCards = [
		['name' => '杀', 'type' => 'basic', 'color' => 'black', 'suit' => '♠', 'num' => '2', 'count' => 1],
		['name' => '杀', 'type' => 'basic', 'color' => 'black', 'suit' => '♠', 'num' => '7', 'count' => 1],
		['name' => '杀', 'type' => 'basic', 'color' => 'black', 'suit' => '♠', 'num' => '8', 'count' => 1],
		['name' => '杀', 'type' => 'basic', 'color' => 'black', 'suit' => '♠', 'num' => '9', 'count' => 1],
		['name' => '杀', 'type' => 'basic', 'color' => 'black', 'suit' => '♠', 'num' => '10', 'count' => 1],
		['name' => '杀', 'type' => 'basic', 'color' => 'black', 'suit' => '♣', 'num' => '2', 'count' => 1],
		['name' => '杀', 'type' => 'basic', 'color' => 'black', 'suit' => '♣', 'num' => '4', 'count' => 1],
		['name' => '杀', 'type' => 'basic', 'color' => 'black', 'suit' => '♣', 'num' => '6', 'count' => 1],
		['name' => '杀', 'type' => 'basic', 'color' => 'black', 'suit' => '♣', 'num' => '8', 'count' => 1],
		['name' => '杀', 'type' => 'basic', 'color' => 'black', 'suit' => '♣', 'num' => 'J', 'count' => 1],
		['name' => '杀', 'type' => 'basic', 'color' => 'red', 'suit' => '♥', 'num' => '10', 'count' => 1],
		['name' => '杀', 'type' => 'basic', 'color' => 'red', 'suit' => '♥', 'num' => 'J', 'count' => 1],
		['name' => '杀', 'type' => 'basic', 'color' => 'red', 'suit' => '♦', 'num' => '6', 'count' => 1],
		['name' => '杀', 'type' => 'basic', 'color' => 'red', 'suit' => '♦', 'num' => '7', 'count' => 1],
		['name' => '杀', 'type' => 'basic', 'color' => 'red', 'suit' => '♦', 'num' => 'K', 'count' => 1],
		['name' => '闪', 'type' => 'basic', 'color' => 'red', 'suit' => '♦', 'num' => '2', 'count' => 1],
		['name' => '闪', 'type' => 'basic', 'color' => 'red', 'suit' => '♦', 'num' => '3', 'count' => 1],
		['name' => '闪', 'type' => 'basic', 'color' => 'red', 'suit' => '♦', 'num' => '6', 'count' => 1],
		['name' => '闪', 'type' => 'basic', 'color' => 'red', 'suit' => '♦', 'num' => '7', 'count' => 1],
		['name' => '闪', 'type' => 'basic', 'color' => 'red', 'suit' => '♦', 'num' => '8', 'count' => 1],
		['name' => '闪', 'type' => 'basic', 'color' => 'red', 'suit' => '♦', 'num' => 'K', 'count' => 1],
		['name' => '闪', 'type' => 'basic', 'color' => 'red', 'suit' => '♥', 'num' => '2', 'count' => 1],
		['name' => '闪', 'type' => 'basic', 'color' => 'red', 'suit' => '♥', 'num' => 'K', 'count' => 1],
		['name' => '桃', 'type' => 'basic', 'color' => 'red', 'suit' => '♥', 'num' => '3', 'count' => 1],
		['name' => '桃', 'type' => 'basic', 'color' => 'red', 'suit' => '♥', 'num' => '4', 'count' => 1],
		['name' => '桃', 'type' => 'basic', 'color' => 'red', 'suit' => '♥', 'num' => '7', 'count' => 1],
		['name' => '桃', 'type' => 'basic', 'color' => 'red', 'suit' => '♥', 'num' => '8', 'count' => 1],
		['name' => '桃', 'type' => 'basic', 'color' => 'red', 'suit' => '♥', 'num' => '9', 'count' => 1],
		['name' => '桃', 'type' => 'basic', 'color' => 'red', 'suit' => '♦', 'num' => 'Q', 'count' => 1],
		['name' => '无中生有', 'type' => 'trick', 'color' => 'red', 'suit' => '♥', 'num' => '7', 'count' => 1],
		['name' => '无中生有', 'type' => 'trick', 'color' => 'red', 'suit' => '♥', 'num' => '8', 'count' => 1],
		['name' => '无中生有', 'type' => 'trick', 'color' => 'red', 'suit' => '♥', 'num' => '9', 'count' => 1],
		['name' => '无中生有', 'type' => 'trick', 'color' => 'red', 'suit' => '♥', 'num' => 'J', 'count' => 1],
		['name' => '顺手牵羊', 'type' => 'trick', 'color' => 'black', 'suit' => '♠', 'num' => '3', 'count' => 2],
		['name' => '顺手牵羊', 'type' => 'trick', 'color' => 'black', 'suit' => '♠', 'num' => '4', 'count' => 2],
		['name' => '顺手牵羊', 'type' => 'trick', 'color' => 'black', 'suit' => '♠', 'num' => 'J', 'count' => 2],
		['name' => '顺手牵羊', 'type' => 'trick', 'color' => 'red', 'suit' => '♦', 'num' => '3', 'count' => 2],
		['name' => '过河拆桥', 'type' => 'trick', 'color' => 'black', 'suit' => '♠', 'num' => '3', 'count' => 2],
		['name' => '过河拆桥', 'type' => 'trick', 'color' => 'black', 'suit' => '♠', 'num' => '4', 'count' => 2],
		['name' => '过河拆桥', 'type' => 'trick', 'color' => 'black', 'suit' => '♣', 'num' => '3', 'count' => 2],
		['name' => '过河拆桥', 'type' => 'trick', 'color' => 'black', 'suit' => '♣', 'num' => '4', 'count' => 2],
		['name' => '决斗', 'type' => 'trick', 'color' => 'black', 'suit' => '♠', 'num' => 'A', 'count' => 2],
		['name' => '决斗', 'type' => 'trick', 'color' => 'black', 'suit' => '♣', 'num' => 'A', 'count' => 2],
		['name' => '决斗', 'type' => 'trick', 'color' => 'red', 'suit' => '♦', 'num' => 'A', 'count' => 1]
	];
	foreach ($rawCards as $item) {
		for ($i = 0; $i < $item['count']; $i++) {
			$deck[] = [
				'cid' => uniqid('c_'),
				'name' => $item['name'],
				'type' => $item['type'],
				'color' => $item['color'],
				'suit' => $item['suit'],
				'num' => $item['num']
			];
		}
	}
	shuffle($deck);
	return $deck;
}

function drawCardsFromState(&$state, $count)
{
	$cards = [];
	for ($i = 0; $i < $count; $i++) {
		if (empty($state['deck'])) {
			if (!empty($state['discard'])) {
				$state['deck'] = $state['discard'];
				shuffle($state['deck']);
				$state['discard'] = [];
			} else {
				break;
			}
		}
		if (!empty($state['deck'])) {
			$cards[] = array_pop($state['deck']);
		}
	}
	return $cards;
}

function addLog(&$state, $msg)
{
	if (!isset($state['logs'])) $state['logs'] = [];
	$time = date('H:i:s');
	$state['logs'][] = "[$time] " . $msg;
	if (count($state['logs']) > 70) array_shift($state['logs']);
}

function getPlayerIndexByUid($state, $uid)
{
	if (empty($state['players'])) return -1;
	foreach ($state['players'] as $idx => $p) {
		if ((int)$p['uid'] === (int)$uid) return $idx;
	}
	return -1;
}

function killPlayer(&$state, $playerIdx, $killerUid = null)
{
	if (!isset($state['players'][$playerIdx])) return;
	if ($state['players'][$playerIdx]['dead']) return;
	$state['players'][$playerIdx]['dead'] = true;
	$state['players'][$playerIdx]['hp'] = 0;
	$deadName = $state['players'][$playerIdx]['name'];
	foreach ($state['players'][$playerIdx]['hand'] as $c) {
		$state['discard'][] = $c;
	}
	$state['players'][$playerIdx]['hand'] = [];
	if ($killerUid !== null) {
		foreach ($state['players'] as $idx => $p) {
			if ($p['uid'] == $killerUid && !$p['dead']) {
				$state['players'][$idx]['kills']++;
				break;
			}
		}
	}
	addLog($state, "<strong>{$deadName}</strong> 被撅飞了");
	checkGameOver($state);
}

function checkGameOver(&$state)
{
	if (!empty($state['status']) && $state['status'] === 'finished') {
		return true;
	}
	$alive = [];
	foreach ($state['players'] as $p) {
		if (!$p['dead']) $alive[] = $p;
	}
	if (count($alive) <= 1) {
		$state['status'] = 'finished';
		$winnerName = count($alive) === 1 ? $alive[0]['name'] : '无';
		addLog($state, "<strong style='color:#f1c40f;font-size:15px;'>游戏结束！最终胜利者是：{$winnerName}！</strong>");
		if (empty($state['records_saved'])) {
			saveGameRecords($state);
			$state['records_saved'] = true;
		}
		return true;
	}
	return false;
}

function saveGameRecords(&$state)
{
	global $conn;
	$roomId = $state['room_id'] ?? 0;
	if (!$roomId) return;
	$winnerUid = null;
	foreach ($state['players'] as $p) {
		if (!$p['dead']) {
			$winnerUid = $p['uid'];
			break;
		}
	}
	$stmt = $conn->prepare("INSERT INTO lolmtoj_game_records (room_id, uid, general_id, is_winner, kills) VALUES (?, ?, ?, ?, ?)");
	foreach ($state['players'] as $p) {
		$isWinner = ($p['uid'] == $winnerUid) ? 1 : 0;
		$stmt->bind_param("iiiii", $roomId, $p['uid'], $p['general']['id'], $isWinner, $p['kills']);
		$stmt->execute();
	}
	$stmt->close();
}

function advanceAoeQueue(&$state)
{
	if (empty($state['pending_response']) || !in_array($state['pending_response']['type'], ['aoe_nanman', 'aoe_sajiao'])) {
		return;
	}
	array_shift($state['pending_response']['targets']);
	while (!empty($state['pending_response']['targets'])) {
		$nextUid = $state['pending_response']['targets'][0];
		$tIdx = getPlayerIndexByUid($state, $nextUid);
		if ($tIdx === -1 || $state['players'][$tIdx]['dead']) {
			array_shift($state['pending_response']['targets']);
		} else {
			break;
		}
	}
	if (empty($state['pending_response']['targets'])) {
		$aoeType = $state['pending_response']['type'];
		$state['pending_response'] = null;
		if ($aoeType === 'aoe_nanman') {
			$currIdx = $state['turn_index'];
			if (!$state['players'][$currIdx]['dead']) {
				startDrawAndPlayPhase($state);
			} else {
				nextTurn($state);
			}
		}
	}
}

function checkDyingQueue(&$state)
{
	if (checkGameOver($state)) return false;
	if (!empty($state['pending_response']) && $state['pending_response']['type'] === 'dying_rescue') {
		$curTgt = $state['pending_response']['target_uid'];
		$tIdx = getPlayerIndexByUid($state, $curTgt);
		if ($tIdx !== -1 && !$state['players'][$tIdx]['dead'] && $state['players'][$tIdx]['hp'] <= 0) {
			return true;
		}
	}
	foreach ($state['players'] as $p) {
		if (!$p['dead'] && $p['hp'] <= 0) {
			if (!empty($state['pending_response']) && $state['pending_response']['type'] !== 'dying_rescue') {
				$state['suspended_response'] = $state['pending_response'];
			}
			$state['pending_response'] = [
				'type' => 'dying_rescue',
				'target_uid' => $p['uid'],
				'target_name' => $p['name'],
				'killer_uid' => $p['killer_uid'] ?? null,
				'killer_name' => '',
				'passed_uids' => []
			];
			addLog($state, "<span style='color:#e74c3c;font-weight:bold;'>【濒死】{$p['name']} 体力降至 {$p['hp']}！</span> 等待打出【桃】救援...");
			return true;
		}
	}
	if (!empty($state['suspended_response'])) {
		$state['pending_response'] = $state['suspended_response'];
		unset($state['suspended_response']);
		if (in_array($state['pending_response']['type'], ['aoe_nanman', 'aoe_sajiao'])) {
			advanceAoeQueue($state);
		}
	}
	return false;
}

function applyDamage(&$state, &$target, $damage, $sourceUid, $sourceName)
{
	$target['hp'] -= $damage;
	$target['killer_uid'] = $sourceUid;
	addLog($state, "<span style='color:#e74c3c;font-weight:bold;'>{$target['name']} 受到 {$damage} 点伤害！</span> (剩余HP: {$target['hp']})");
	checkDyingQueue($state);
}

function nextTurn(&$state)
{
	if (checkGameOver($state)) return;
	$state['no_tiaojiao_extra'] = false;
	$count = count($state['players']);
	$tries = 0;
	do {
		$state['turn_index'] = ($state['turn_index'] + 1) % $count;
		$curr = &$state['players'][$state['turn_index']];
		$tries++;
		if ($tries > 10) break;
	} while ($curr['dead']);

	$curr = &$state['players'][$state['turn_index']];

	if (!empty($curr['marks']['xiaomaoliang']) && $curr['marks']['xiaomaoliang'] >= 2) {
		$raboIdx = -1;
		foreach ($state['players'] as $idx => $p) {
			if (!$p['dead'] && $p['general']['name'] === 'Rabo') {
				$raboIdx = $idx;
				break;
			}
		}
		if ($raboIdx !== -1) {
			$origName = $curr['name'];
			$curr['marks']['xiaomaoliang'] = 0;
			$state['turn_index'] = $raboIdx;
			$curr = &$state['players'][$state['turn_index']];
			$state['no_tiaojiao_extra'] = true;
			addLog($state, "<span style='color:#9b59b6;font-weight:bold;'>【控制】</span> <strong>{$origName}</strong> 拥有 2 个“小猫梁”标记，回合被替换为 <strong>{$curr['name']}</strong> 的回合！（该回合内无法使用【调教】）");
		}
	}

	addLog($state, "轮到 <strong>{$curr['name']}</strong> 的回合");
	if ($curr['flipped']) {
		$curr['flipped'] = false;
		addLog($state, "<strong>{$curr['name']}</strong> 翻面复原，跳过本回合");
		nextTurn($state);
		return;
	}
	$state['used_sha_this_turn'] = false;
	$state['used_ruiping'] = false;
	$state['used_sajiao'] = false;
	$state['used_tiaojiao'] = false;
	$state['used_baolun'] = false;
	$state['pending_response'] = null;

	if ($curr['general']['name'] === '六面体') {
		addLog($state, "<span style='color:#3498db;font-weight:bold;'>【暴政】</span> 准备阶段进行判定！");
		$jCards = drawCardsFromState($state, 1);
		if (!empty($jCards)) {
			$jc = $jCards[0];
			$state['discard'][] = $jc;
			addLog($state, "判定牌为：[{$jc['suit']}{$jc['num']} {$jc['name']}]（" . ($jc['color'] === 'red' ? '红色' : '黑色') . "）");
			if ($jc['color'] !== 'red') {
				addLog($state, "<span style='color:#e74c3c;font-weight:bold;'>【暴政】生效！</span> 视为打出一张【南蛮入侵】！");
				$targets = [];
				$pCount = count($state['players']);
				for ($i = 1; $i < $pCount; $i++) {
					$tIdx = ($state['turn_index'] + $i) % $pCount;
					if (!$state['players'][$tIdx]['dead']) {
						$targets[] = $state['players'][$tIdx]['uid'];
					}
				}
				if (!empty($targets)) {
					$state['pending_response'] = [
						'type' => 'aoe_nanman',
						'from_uid' => $curr['uid'],
						'from_name' => $curr['name'],
						'targets' => $targets
					];
					return;
				}
			}
		}
	}

	if ($curr['general']['name'] === 'Ydch' && !$curr['dead']) {
		if ($curr['marks']['xinxin'] > 0) {
			$state['phase'] = 'JIJIANG_SELECT';
			addLog($state, "<span style='color:#3498db;font-weight:bold;'>【信心】</span> 必须指定一名其他角色转移“信心”标记并对其造成1点伤害");
			return;
		} else {
			$curr['marks']['xinxin'] += 1;
			$curr['hp'] = min($curr['maxHp'], $curr['hp'] + 1);
			addLog($state, "<strong>Ydch</strong> 获得 1 枚“信心”标记，并恢复 1 点体力（当前HP: {$curr['hp']}/{$curr['maxHp']}）");
		}
	}
	startDrawAndPlayPhase($state);
}

function startDrawAndPlayPhase(&$state)
{
	$curr = &$state['players'][$state['turn_index']];
	$drawn = drawCardsFromState($state, 2);
	$curr['hand'] = array_merge($curr['hand'], $drawn);
	addLog($state, "<strong>{$curr['name']}</strong> 摸了 2 张牌");
	$state['phase'] = 'PLAY';

	if ($curr['general']['name'] === 'Ydch' && !$curr['dead'] && count($curr['hand']) > 0) {
		$maxM = 0;
		foreach ($state['players'] as $p) {
			if (!$p['dead'] && (int)$p['marks']['xinxin'] > $maxM) $maxM = (int)$p['marks']['xinxin'];
		}
		if ($maxM > 0) {
			$bestIdx = -1;
			foreach ($state['players'] as $idx => $p) {
				if (!$p['dead'] && (int)$p['marks']['xinxin'] === $maxM && $p['uid'] !== $curr['uid']) {
					$bestIdx = $idx;
					break;
				}
			}
			if ($bestIdx !== -1) {
				$best = &$state['players'][$bestIdx];
				addLog($state, "<span style='color:#f39c12;font-weight:bold;'>【泄密】</span> <strong>{$curr['name']}</strong> 拥有手牌，必须将一张手牌交给“信心”标记最多（{$maxM}）的 <strong>{$best['name']}</strong>！");
				$state['pending_response'] = [
					'type' => 'xiemi_give',
					'actor_name' => $curr['name'],
					'target_uid' => $best['uid'],
					'target_name' => $best['name']
				];
			} else {
				addLog($state, "<span style='color:#f39c12;font-weight:bold;'>【泄密】</span> “信心”标记最多的是 <strong>{$curr['name']}</strong> 自己，无效果。");
			}
		}
	}
}

function askZichao(&$state)
{
	$curr = &$state['players'][$state['turn_index']];
	if ($curr['general']['name'] !== 'zhoumurui' || $curr['dead']) {
		nextTurn($state);
		return;
	}
	$maxHand = 0;
	foreach ($state['players'] as $p) {
		if (!$p['dead'] && $p['uid'] !== $curr['uid']) {
			$maxHand = max($maxHand, count($p['hand']));
		}
	}
	$state['pending_response'] = [
		'type' => 'zichao_ask',
		'target_uid' => $curr['uid'],
		'target_name' => $curr['name'],
		'max_hand' => $maxHand
	];
}

if ($_SERVER['REQUEST_METHOD'] === 'POST' && isset($_POST['api_action'])) {
	header('Content-Type: application/json');
	$api = $_POST['api_action'];

	if ($api === 'get_rooms') {
		$res = $conn->query("SELECT r.*, u.name as host_name, COUNT(p.id) as current_players 
			FROM lolmtoj_rooms r 
			LEFT JOIN users u ON r.host_uid = u.uid 
			LEFT JOIN lolmtoj_room_players p ON r.id = p.room_id 
			GROUP BY r.id ORDER BY r.id DESC LIMIT 20");
		$rooms = [];
		while ($r = $res->fetch_assoc()) {
			$rooms[] = $r;
		}
		echo json_encode(['success' => true, 'rooms' => $rooms]);
		exit;
	}

	if ($api === 'create_room') {
		$title = trim($_POST['title'] ?? '') ?: ($login_name . '的对局');
		$max_p = max(2, min(6, (int) ($_POST['max_players'] ?? 6)));
		$code = substr(md5(uniqid(mt_rand(), true)), 0, 8);
		$stmt = $conn->prepare("INSERT INTO lolmtoj_rooms (room_code, host_uid, title, max_players, status, version) VALUES (?, ?, ?, ?, 'waiting', 1)");
		$stmt->bind_param("sisi", $code, $login_uid, $title, $max_p);
		$stmt->execute();
		$roomId = $stmt->insert_id;
		$stmt->close();

		$conn->query("INSERT INTO lolmtoj_room_players (room_id, uid, general_id, is_ready) VALUES ($roomId, $login_uid, 0, 1)");
		echo json_encode(['success' => true, 'room_id' => $roomId]);
		exit;
	}

	if ($api === 'join_room') {
		$roomId = (int) $_POST['room_id'];
		$chk = $conn->query("SELECT * FROM lolmtoj_rooms WHERE id = $roomId AND status = 'waiting' LIMIT 1")->fetch_assoc();
		if (!$chk) {
			echo json_encode(['success' => false, 'msg' => '房间已开始或不存在']);
			exit;
		}
		$cnt = $conn->query("SELECT COUNT(*) as c FROM lolmtoj_room_players WHERE room_id = $roomId")->fetch_assoc()['c'];
		if ($cnt >= $chk['max_players']) {
			echo json_encode(['success' => false, 'msg' => '房间已满员']);
			exit;
		}
		$conn->query("INSERT IGNORE INTO lolmtoj_room_players (room_id, uid, general_id, is_ready) VALUES ($roomId, $login_uid, 0, 0)");
		$conn->query("UPDATE lolmtoj_rooms SET version = version + 1 WHERE id = $roomId");
		echo json_encode(['success' => true]);
		exit;
	}

	if ($api === 'kick_player') {
		$roomId = (int) $_POST['room_id'];
		$targetUid = (int) $_POST['target_uid'];
		$room = $conn->query("SELECT * FROM lolmtoj_rooms WHERE id = $roomId AND status = 'waiting' LIMIT 1")->fetch_assoc();
		if (!$room || (int)$room['host_uid'] !== $login_uid) {
			echo json_encode(['success' => false, 'msg' => '无权操作或房间状态已变更']);
			exit;
		}
		if ($targetUid === $login_uid) {
			echo json_encode(['success' => false, 'msg' => '不能踢出自己']);
			exit;
		}
		$conn->query("DELETE FROM lolmtoj_room_players WHERE room_id = $roomId AND uid = $targetUid");
		$conn->query("UPDATE lolmtoj_rooms SET version = version + 1 WHERE id = $roomId");
		echo json_encode(['success' => true]);
		exit;
	}

	if ($api === 'leave_room') {
		$roomId = (int) $_POST['room_id'];
		$room = $conn->query("SELECT * FROM lolmtoj_rooms WHERE id = $roomId LIMIT 1")->fetch_assoc();
		if ($room && $room['status'] !== 'waiting') {
			$state = json_decode($room['game_state'] ?? '{}', true);
			if (!empty($state['players'])) {
				foreach ($state['players'] as $p) {
					if ($p['uid'] == $login_uid && $p['dead']) {
						echo json_encode(['success' => true]);
						exit;
					}
				}
				foreach ($state['players'] as $p) {
					if ($p['uid'] == $login_uid) {
						echo json_encode(['success' => false, 'msg' => '已开始，无法退出房间']);
						exit;
					}
				}
			}
		}
		$conn->query("DELETE FROM lolmtoj_room_players WHERE room_id = $roomId AND uid = $login_uid");
		$cnt = $conn->query("SELECT COUNT(*) as c FROM lolmtoj_room_players WHERE room_id = $roomId")->fetch_assoc()['c'];
		if ($cnt == 0) {
			$conn->query("DELETE FROM lolmtoj_rooms WHERE id = $roomId");
		} else {
			$newHost = $conn->query("SELECT uid FROM lolmtoj_room_players WHERE room_id = $roomId ORDER BY id ASC LIMIT 1")->fetch_assoc()['uid'];
			$conn->query("UPDATE lolmtoj_rooms SET host_uid = $newHost, version = version + 1 WHERE id = $roomId");
		}
		echo json_encode(['success' => true]);
		exit;
	}

	if ($api === 'update_prep') {
		$roomId = (int) $_POST['room_id'];
		$genId = (int) ($_POST['general_id'] ?? 0);
		$ready = (int) ($_POST['is_ready'] ?? 0);

		if ($genId > 0) {
			if (!isset($GENERALS_CONFIG[$genId])) {
				echo json_encode(['success' => false, 'msg' => '该武将不存在']);
				exit;
			}
			$dup = $conn->query("SELECT p.uid, u.name FROM lolmtoj_room_players p
				LEFT JOIN users u ON p.uid = u.uid WHERE p.room_id = $roomId AND p.general_id = $genId AND p.uid != $login_uid LIMIT 1")->fetch_assoc();
			if ($dup) {
				echo json_encode(['success' => false, 'msg' => "该武将已被玩家【" . ($dup['name'] ?: '其他玩家') . "】选择！"]);
				exit;
			}
		}

		$conn->query("UPDATE lolmtoj_room_players SET general_id = $genId, is_ready = $ready WHERE room_id = $roomId AND uid = $login_uid");
		$conn->query("UPDATE lolmtoj_rooms SET version = version + 1 WHERE id = $roomId");
		echo json_encode(['success' => true]);
		exit;
	}

	if ($api === 'start_game') {
		$roomId = (int) $_POST['room_id'];
		$room = $conn->query("SELECT * FROM lolmtoj_rooms WHERE id = $roomId LIMIT 1")->fetch_assoc();
		if ($room['host_uid'] != $login_uid) {
			echo json_encode(['success' => false, 'msg' => '只有房主可开启游戏']);
			exit;
		}

		$playersRes = $conn->query("SELECT p.*, u.name, u.avatar FROM lolmtoj_room_players p LEFT JOIN users u ON p.uid = u.uid WHERE p.room_id = $roomId");
		$players = [];
		$unready = false;
		$genIds = [];
		$noGeneral = false;

		while ($p = $playersRes->fetch_assoc()) {
			if ($p['general_id'] <= 0) {
				$noGeneral = true;
			}
			if ($p['general_id'] > 0 && in_array($p['general_id'], $genIds)) {
				echo json_encode(['success' => false, 'msg' => '存在重复选择的武将，每位武将只能由一人选择']);
				exit;
			}
			$genIds[] = $p['general_id'];
			if ($p['uid'] != $login_uid && !$p['is_ready']) {
				$unready = true;
			}
			$players[] = $p;
		}

		if (count($players) < 2) {
			echo json_encode(['success' => false, 'msg' => '至少需要 2 名玩家才能开战']);
			exit;
		}
		if ($noGeneral) {
			echo json_encode(['success' => false, 'msg' => '尚有玩家未选择武将']);
			exit;
		}
		if ($unready) {
			echo json_encode(['success' => false, 'msg' => '尚有玩家未准备']);
			exit;
		}

		$deck = generateDeck();
		$gameState = [
			'status' => 'playing',
			'phase' => 'START',
			'turn_index' => 0,
			'used_sha_this_turn' => false,
			'used_ruiping' => false,
			'used_sajiao' => false,
			'used_tiaojiao' => false,
			'used_guanshui' => false,
			'used_baolun' => false,
			'pending_response' => null,
			'discard' => [],
			'deck' => $deck,
			'players' => [],
			'logs' => [],
			'room_id' => $roomId,
			'captcha' => null,
			'captcha_timeout' => 0
		];

		$now = time();
		foreach ($players as $p) {
			$gConfig = $GENERALS_CONFIG[$p['general_id']];
			$hand = drawCardsFromState($gameState, 4);
			$gameState['players'][] = [
				'uid' => (int) $p['uid'],
				'name' => $p['name'],
				'avatar' => $p['avatar'] ?: '',
				'general' => $gConfig,
				'hp' => $gConfig['hp'],
				'maxHp' => $gConfig['maxHp'],
				'hand' => $hand,
				'marks' => ['xinxin' => 0, 'ruiping' => 0, 'xiaomaoliang' => 0],
				'flipped' => false,
				'dead' => false,
				'kills' => 0,
				'killer_uid' => null,
				'last_seen' => $now
			];
		}

		addLog($gameState, "<strong>lmtoj杀正式开始！</strong>");
		addLog($gameState, "<strong>注意离开页面60秒自动认输</strong>");
		startDrawAndPlayPhase($gameState);

		$stateJson = $conn->real_escape_string(json_encode($gameState, JSON_UNESCAPED_UNICODE));
		$conn->query("UPDATE lolmtoj_rooms SET status = 'playing', game_state = '$stateJson', version = version + 1 WHERE id = $roomId");
		echo json_encode(['success' => true]);
		exit;
	}

	if ($api === 'poll_state') {
		$roomId = (int) $_POST['room_id'];
		$clientVer = (int) ($_POST['version'] ?? 0);
		$room = $conn->query("SELECT * FROM lolmtoj_rooms WHERE id = $roomId LIMIT 1")->fetch_assoc();
		if (!$room) {
			echo json_encode(['success' => false, 'msg' => '房间不存在或已解散']);
			exit;
		}

		$now = time();
		$gameState = json_decode($room['game_state'] ?? '{}', true);
		$stateUpdated = false;

		if ($room['status'] === 'playing' && !empty($gameState['players'])) {
			foreach ($gameState['players'] as &$p) {
				if ($p['uid'] == $login_uid) {
					$p['last_seen'] = $now;
					$stateUpdated = true;
				}
			}
			unset($p);

			$timedOutPlayers = false;
			foreach ($gameState['players'] as $idx => &$p) {
				if (!$p['dead']) {
					$lastSeen = $p['last_seen'] ?? $now;
					if ($now - $lastSeen > 60) {
						addLog($gameState, "<strong>{$p['name']}</strong> 超时未响应(60秒)，自动判负！");
						killPlayer($gameState, $idx, null);
						$timedOutPlayers = true;
						$stateUpdated = true;
					}
				}
			}
			unset($p);

			if ($timedOutPlayers) {
				checkGameOver($gameState);
				if ($gameState['status'] !== 'finished') {
					$curr = &$gameState['players'][$gameState['turn_index']];
					if ($curr['dead']) {
						nextTurn($gameState);
					}
					if (!empty($gameState['pending_response'])) {
						checkDyingQueue($gameState);
					}
				}
			}
		}

		if ($stateUpdated) {
			$roomStatus = $gameState['status'] ?? $room['status'];
			$stateJson = $conn->real_escape_string(json_encode($gameState, JSON_UNESCAPED_UNICODE));
			$conn->query("UPDATE lolmtoj_rooms SET status = '$roomStatus', game_state = '$stateJson', version = version + 1 WHERE id = $roomId");
			$room['status'] = $roomStatus;
			$room['version']++;
		}

		if ($clientVer === (int) $room['version']) {
			echo json_encode(['success' => true, 'changed' => false, 'version' => $clientVer]);
			exit;
		}

		$playersRes = $conn->query("SELECT p.*, u.name, u.avatar FROM lolmtoj_room_players p LEFT JOIN users u ON p.uid = u.uid WHERE p.room_id = $roomId");
		$roomPlayers = [];
		$isPlayer = false;
		while ($p = $playersRes->fetch_assoc()) {
			if ($p['uid'] == $login_uid) $isPlayer = true;
			$roomPlayers[] = $p;
		}

		if (!empty($gameState['pending_response'])
			&& in_array($gameState['pending_response']['type'], ['guanshui_select', 'zhipai_arrange'], true)
			&& (int) $gameState['pending_response']['from_uid'] === $login_uid) {
			$prType = $gameState['pending_response']['type'];
			$pool = [];
			if ($prType === 'guanshui_select') {
				foreach ($gameState['players'] as $gp) {
					if (!$gp['dead'] && (int) $gp['uid'] !== $login_uid) {
						foreach ($gp['hand'] as $c) {
							$pool[] = ['cid' => $c['cid'], 'name' => $c['name'], 'suit' => $c['suit'], 'num' => $c['num'], 'color' => $c['color'], 'type' => $c['type'], 'owner_name' => $gp['name']];
						}
					}
				}
			} else {
				$ztIdx = getPlayerIndexByUid($gameState, $gameState['pending_response']['target_uid']);
				if ($ztIdx !== -1) {
					foreach ($gameState['players'][$ztIdx]['hand'] as $c) {
						$pool[] = ['cid' => $c['cid'], 'name' => $c['name'], 'suit' => $c['suit'], 'num' => $c['num'], 'color' => $c['color'], 'type' => $c['type'], 'owner_name' => $gameState['players'][$ztIdx]['name']];
					}
				}
			}
			$gameState['pending_response']['pool_view'] = $pool;
		}

		if (!empty($gameState['players'])) {
			foreach ($gameState['players'] as &$gp) {
				if ($gp['uid'] !== $login_uid) {
					$gp['hand_count'] = count($gp['hand']);
					$gp['hand'] = [];
				} else {
					$gp['hand_count'] = count($gp['hand']);
				}
			}
			unset($gp);
		}

		$chatRes = $conn->query("SELECT uid, name, msg, created_at FROM lolmtoj_chat WHERE room_id = $roomId ORDER BY id DESC LIMIT 20");
		$chatMsgs = [];
		while ($row = $chatRes->fetch_assoc()) {
			$chatMsgs[] = [
				'uid' => (int) $row['uid'],
				'name' => htmlspecialchars($row['name']),
				'msg' => htmlspecialchars($row['msg']),
				'time' => date('H:i:s', strtotime($row['created_at']))
			];
		}
		$chatMsgs = array_reverse($chatMsgs);

		echo json_encode([
			'success' => true,
			'changed' => true,
			'version' => (int) $room['version'],
			'room' => $room,
			'room_players' => $roomPlayers,
			'game_state' => $gameState,
			'my_uid' => $login_uid,
			'is_spectator' => !$isPlayer,
			'chat_messages' => $chatMsgs
		]);
		exit;
	}

	if ($api === 'game_action') {
		$roomId = (int) $_POST['room_id'];
		$subAction = $_POST['action_type'];
		$targetUid = (int) ($_POST['target_uid'] ?? 0);
		$cardIdx = isset($_POST['card_index']) ? (int) $_POST['card_index'] : -1;

		$room = $conn->query("SELECT * FROM lolmtoj_rooms WHERE id = $roomId AND status = 'playing' LIMIT 1")->fetch_assoc();
		if (!$room) {
			echo json_encode(['success' => false, 'msg' => '对局未在进行']);
			exit;
		}

		$state = json_decode($room['game_state'], true);
		$curr = &$state['players'][$state['turn_index']];
		$isMyTurn = ($curr['uid'] === $login_uid);

		if ($subAction === 'surrender') {
			$myIdx = getPlayerIndexByUid($state, $login_uid);
			if ($myIdx !== -1 && !$state['players'][$myIdx]['dead']) {
				addLog($state, "<strong>{$state['players'][$myIdx]['name']}</strong> 认输，直接阵亡！");
				killPlayer($state, $myIdx, null);
				if (!checkGameOver($state)) {
					if ($state['turn_index'] === $myIdx) {
						nextTurn($state);
					}
					if (!empty($state['pending_response'])) {
						checkDyingQueue($state);
					}
				}
			}
		} elseif ($subAction === 'captcha_answer') {
			$answer = (int) ($_POST['answer'] ?? -1);
			$myIdx = getPlayerIndexByUid($state, $login_uid);
			if ($myIdx !== -1 && !empty($state['captcha'])) {
				if ($answer == $state['captcha']['answer']) {
					addLog($state, "<strong>{$state['players'][$myIdx]['name']}</strong> 人机验证通过！");
					$state['captcha'] = null;
					$state['captcha_timeout'] = time();
				} else {
					addLog($state, "<strong>{$state['players'][$myIdx]['name']}</strong> 人机验证答案错误！");
				}
			}
		} elseif ($subAction === 'respond_dying_peach') {
			$resp = $state['pending_response'];
			if ($resp && $resp['type'] === 'dying_rescue') {
				$userPlayerIdx = getPlayerIndexByUid($state, $login_uid);
				$dyingIdx = getPlayerIndexByUid($state, $resp['target_uid']);
				$targetPlayerName = ($dyingIdx !== -1) ? $state['players'][$dyingIdx]['name'] : $resp['target_name'];

				$usePeach = (bool) ($_POST['use_peach'] ?? false);
				if ($usePeach && $userPlayerIdx !== -1 && !$state['players'][$userPlayerIdx]['dead']) {
					$uHand = &$state['players'][$userPlayerIdx]['hand'];
					if (isset($uHand[$cardIdx]) && $uHand[$cardIdx]['name'] === '桃') {
						$peachCard = array_splice($uHand, $cardIdx, 1)[0];
						$state['discard'][] = $peachCard;
						$state['players'][$dyingIdx]['hp'] = min($state['players'][$dyingIdx]['maxHp'], $state['players'][$dyingIdx]['hp'] + 1);
						addLog($state, "<strong>{$state['players'][$userPlayerIdx]['name']}</strong> 使用了【桃】对 <strong>{$targetPlayerName}</strong> 进行抢救！(当前HP: {$state['players'][$dyingIdx]['hp']}/{$state['players'][$dyingIdx]['maxHp']})");

						if ($state['players'][$dyingIdx]['hp'] > 0) {
							addLog($state, "<strong>{$targetPlayerName}</strong> 成功脱离濒死状态！");
							$state['pending_response'] = null;
							if (!checkDyingQueue($state)) {
								if ($state['phase'] === 'JIJIANG_SELECT') {
									startDrawAndPlayPhase($state);
								} elseif (!empty($state['end_turn_pending'])) {
									unset($state['end_turn_pending']);
									nextTurn($state);
								}
							}
						} else {
							$state['pending_response']['passed_uids'] = [];
							addLog($state, "<strong>{$targetPlayerName}</strong> 仍处于濒死状态 (HP: {$state['players'][$dyingIdx]['hp']})，等待继续打出【桃】...");
						}
					} else {
						echo json_encode(['success' => false, 'msg' => '请选择手牌中的【桃】']);
						exit;
					}
				} elseif (!$usePeach && $userPlayerIdx !== -1 && !$state['players'][$userPlayerIdx]['dead']) {
					if (!isset($state['pending_response']['passed_uids'])) {
						$state['pending_response']['passed_uids'] = [];
					}
					if (!in_array($login_uid, $state['pending_response']['passed_uids'])) {
						$state['pending_response']['passed_uids'][] = $login_uid;
						addLog($state, "<strong>{$state['players'][$userPlayerIdx]['name']}</strong> 选择不救");
					}

					$peachHolders = [];
					foreach ($state['players'] as $p) {
						if (!$p['dead']) {
							foreach ($p['hand'] as $c) {
								if ($c['name'] === '桃') {
									$peachHolders[] = $p['uid'];
									break;
								}
							}
						}
					}

					$allPeachHoldersPassed = true;
					foreach ($peachHolders as $pUid) {
						if (!in_array($pUid, $state['pending_response']['passed_uids'])) {
							$allPeachHoldersPassed = false;
							break;
						}
					}

					if ($allPeachHoldersPassed) {
						addLog($state, "无玩家继续出【桃】，<strong>{$targetPlayerName}</strong> 抢救无效！");
						killPlayer($state, $dyingIdx, $resp['killer_uid']);
						$state['pending_response'] = null;
						if (!checkGameOver($state)) {
							if (!checkDyingQueue($state)) {
								if ($state['phase'] === 'JIJIANG_SELECT') {
									startDrawAndPlayPhase($state);
								} elseif (!empty($state['end_turn_pending'])) {
									unset($state['end_turn_pending']);
									nextTurn($state);
								}
							}
						}
					}
				}
			}
		} elseif ($subAction === 'respond_shan') {
			$resp = $state['pending_response'];
			if ($resp && $resp['type'] === 'respond_shan' && $resp['target_uid'] === $login_uid) {
				$myIdx = getPlayerIndexByUid($state, $login_uid);
				$useShan = (bool) ($_POST['use_shan'] ?? false);
				if ($useShan) {
					if ($myIdx !== -1 && isset($state['players'][$myIdx]['hand'][$cardIdx]) && $state['players'][$myIdx]['hand'][$cardIdx]['name'] === '闪') {
						$shanCard = array_splice($state['players'][$myIdx]['hand'], $cardIdx, 1)[0];
						$state['discard'][] = $shanCard;
						addLog($state, "<strong>{$state['players'][$myIdx]['name']}</strong> 打出了【闪】，闪避了【杀】！");
						$state['pending_response'] = null;
					} else {
						echo json_encode(['success' => false, 'msg' => '请选择手牌中的【闪】']);
						exit;
					}
				} else {
					$state['pending_response'] = null;
					if ($myIdx !== -1) {
						applyDamage($state, $state['players'][$myIdx], 1, $resp['from_uid'], $resp['from_name']);
					}
				}
			}
		} elseif ($subAction === 'respond_duel_sha') {
			$resp = $state['pending_response'];
			if ($resp && $resp['type'] === 'duel_sha' && $resp['responder_uid'] === $login_uid) {
				$myIdx = getPlayerIndexByUid($state, $login_uid);
				$useSha = (bool) ($_POST['use_sha'] ?? false);
				if ($useSha) {
					if ($myIdx !== -1 && isset($state['players'][$myIdx]['hand'][$cardIdx]) && $state['players'][$myIdx]['hand'][$cardIdx]['name'] === '杀') {
						$shaCard = array_splice($state['players'][$myIdx]['hand'], $cardIdx, 1)[0];
						$state['discard'][] = $shaCard;
						addLog($state, "<strong>{$state['players'][$myIdx]['name']}</strong> 打出了【杀】应战决斗！");
						$prevResponderUid = $resp['responder_uid'];
						$prevResponderName = $resp['responder_name'];
						$state['pending_response']['responder_uid'] = $resp['opponent_uid'];
						$state['pending_response']['responder_name'] = $resp['opponent_name'];
						$state['pending_response']['opponent_uid'] = $prevResponderUid;
						$state['pending_response']['opponent_name'] = $prevResponderName;
					} else {
						echo json_encode(['success' => false, 'msg' => '请选择手牌中的【杀】']);
						exit;
					}
				} else {
					addLog($state, "<strong>{$state['players'][$myIdx]['name']}</strong> 放弃出【杀】！");
					$oppUid = $resp['opponent_uid'];
					$oppName = $resp['opponent_name'];
					$state['pending_response'] = null;
					if (!empty($resp['prevent_damage'])) {
						addLog($state, "<span style='color:#16a085;font-weight:bold;'>【暴论】</span> 防止了此伤害！");
					} elseif ($myIdx !== -1) {
						applyDamage($state, $state['players'][$myIdx], 1, $oppUid, $oppName);
					}
				}
			}
		} elseif ($subAction === 'respond_aoe_nanman') {
			$resp = $state['pending_response'];
			if ($resp && $resp['type'] === 'aoe_nanman' && !empty($resp['targets']) && $resp['targets'][0] === $login_uid) {
				$myIdx = getPlayerIndexByUid($state, $login_uid);
				$useSha = (bool) ($_POST['use_sha'] ?? false);
				if ($useSha) {
					if ($myIdx !== -1 && isset($state['players'][$myIdx]['hand'][$cardIdx]) && $state['players'][$myIdx]['hand'][$cardIdx]['name'] === '杀') {
						$shaCard = array_splice($state['players'][$myIdx]['hand'], $cardIdx, 1)[0];
						$state['discard'][] = $shaCard;
						addLog($state, "<strong>{$state['players'][$myIdx]['name']}</strong> 打出了【杀】响应【南蛮入侵】");
						advanceAoeQueue($state);
					} else {
						echo json_encode(['success' => false, 'msg' => '请选择手牌中的【杀】']);
						exit;
					}
				} else {
					addLog($state, "<strong>{$state['players'][$myIdx]['name']}</strong> 未出【杀】，受到 1 点伤害！");
					if ($myIdx !== -1) {
						applyDamage($state, $state['players'][$myIdx], 1, $resp['from_uid'], $resp['from_name']);
					}
					advanceAoeQueue($state);
				}
			}
		} elseif ($subAction === 'respond_aoe_sajiao') {
			$resp = $state['pending_response'];
			if ($resp && $resp['type'] === 'aoe_sajiao' && !empty($resp['targets']) && $resp['targets'][0] === $login_uid) {
				$myIdx = getPlayerIndexByUid($state, $login_uid);
				$useCard = (bool) ($_POST['use_card'] ?? false);
				if ($useCard) {
					$indices = json_decode($_POST['card_indices'] ?? '[]', true);
					if (!is_array($indices)) $indices = [];
					$indices = array_values(array_unique(array_map('intval', $indices)));
					$valid = (count($indices) === 2);
					foreach ($indices as $idx) {
						if ($myIdx === -1 || !isset($state['players'][$myIdx]['hand'][$idx])) $valid = false;
					}
					if (!$valid) {
						echo json_encode(['success' => false, 'msg' => '请选择 2 张手牌弃置']);
						exit;
					}
					rsort($indices);
					foreach ($indices as $idx) {
						$state['discard'][] = array_splice($state['players'][$myIdx]['hand'], $idx, 1)[0];
					}
					addLog($state, "<strong>{$state['players'][$myIdx]['name']}</strong> 弃置了 2 张手牌应对【撒娇】");
					advanceAoeQueue($state);
				} else {
					addLog($state, "<strong>{$state['players'][$myIdx]['name']}</strong> 未弃牌，受到 1 点伤害！");
					if ($myIdx !== -1) {
						applyDamage($state, $state['players'][$myIdx], 1, $resp['from_uid'], $resp['from_name']);
					}
					advanceAoeQueue($state);
				}
			}
		} elseif ($subAction === 'respond_ruiping_discard') {
			$resp = $state['pending_response'];
			if ($resp && $resp['type'] === 'ruiping_discard' && $resp['target_uid'] === $login_uid) {
				$indices = json_decode($_POST['card_indices'] ?? '[]', true);
				$myIdx = getPlayerIndexByUid($state, $login_uid);
				if ($myIdx !== -1) {
					rsort($indices);
					$discardedCount = 0;
					foreach ($indices as $idx) {
						if (isset($state['players'][$myIdx]['hand'][$idx])) {
							$state['discard'][] = array_splice($state['players'][$myIdx]['hand'], $idx, 1)[0];
							$discardedCount++;
						}
					}
					addLog($state, "<strong>{$state['players'][$myIdx]['name']}</strong> 弃置了 {$discardedCount} 张手牌！");
					$state['pending_response'] = null;
				}
			}
		} elseif ($subAction === 'confirm_discard' && $isMyTurn && $state['phase'] === 'DISCARD') {
			$indices = json_decode($_POST['card_indices'] ?? '[]', true);
			rsort($indices);
			$discardedCount = 0;
			foreach ($indices as $idx) {
				if (isset($curr['hand'][$idx])) {
					$state['discard'][] = array_splice($curr['hand'], $idx, 1)[0];
					$discardedCount++;
				}
			}
			addLog($state, "<strong>{$curr['name']}</strong> 弃置了 {$discardedCount} 张手牌");
			askZichao($state);
		} elseif ($subAction === 'skill_jijiang' && $state['phase'] === 'JIJIANG_SELECT' && $curr['uid'] === $login_uid) {
			$tIdx = getPlayerIndexByUid($state, $targetUid);
			if ($tIdx !== -1 && !$state['players'][$tIdx]['dead'] && $state['players'][$tIdx]['uid'] !== $curr['uid']) {
				$curr['marks']['xinxin'] -= 1;
				$state['players'][$tIdx]['marks']['xinxin'] += 1;
				addLog($state, "<span style='color:#3498db;font-weight:bold;'>【信心】</span> <strong>Ydch</strong> 将 1 枚“信心”标记转移给了 <strong>{$state['players'][$tIdx]['name']}</strong> 并对其造成 1 点伤害！");
				applyDamage($state, $state['players'][$tIdx], 1, $curr['uid'], $curr['name']);
			}
			if (!checkDyingQueue($state)) {
				startDrawAndPlayPhase($state);
			}
		} elseif ($subAction === 'respond_xiemi_give') {
			$resp = $state['pending_response'];
			if ($resp && $resp['type'] === 'xiemi_give' && $curr['uid'] === $login_uid) {
				if (!isset($curr['hand'][$cardIdx])) {
					echo json_encode(['success' => false, 'msg' => '请先选择一张要交出的手牌']);
					exit;
				}
				$tIdx = getPlayerIndexByUid($state, $resp['target_uid']);
				if ($tIdx !== -1 && !$state['players'][$tIdx]['dead']) {
					$card = array_splice($curr['hand'], $cardIdx, 1)[0];
					$state['players'][$tIdx]['hand'][] = $card;
					addLog($state, "<span style='color:#f39c12;font-weight:bold;'>【泄密】</span> <strong>{$curr['name']}</strong> 将一张手牌 [{$card['suit']}{$card['num']} {$card['name']}] 交给了 <strong>{$state['players'][$tIdx]['name']}</strong>！");
				}
				$state['pending_response'] = null;
			}
		} elseif ($subAction === 'skill_ruiping' && $isMyTurn && $state['phase'] === 'PLAY' && !$state['used_ruiping'] && empty($state['pending_response']) && $curr['general']['name'] === 'Gary0') {
			$state['used_ruiping'] = true;
			$tIdx = getPlayerIndexByUid($state, $targetUid);
			if ($tIdx !== -1 && !$state['players'][$tIdx]['dead']) {
				$tp = &$state['players'][$tIdx];
				addLog($state, "<span style='color:#3498db;font-weight:bold;'>【瑞平】</span> <strong>{$curr['name']}</strong> 锐评了 <strong>{$tp['name']}</strong>");
				if ($tp['marks']['ruiping'] > 0) {
					if (count($tp['hand']) <= 2) {
						$discCount = count($tp['hand']);
						foreach ($tp['hand'] as $dh) $state['discard'][] = $dh;
						$tp['hand'] = [];
						addLog($state, "<strong>{$tp['name']}</strong> 已有“瑞平”标记，弃置了全部 ({$discCount}) 张手牌！");
					} else {
						addLog($state, "<strong>{$tp['name']}</strong> 已有“瑞平”标记，需自主选择弃置 2 张手牌！");
						$state['pending_response'] = [
							'type' => 'ruiping_discard',
							'target_uid' => $tp['uid'],
							'target_name' => $tp['name'],
							'count' => 2
						];
					}
				} else {
					$tp['marks']['ruiping'] += 1;
					addLog($state, "<strong>{$tp['name']}</strong> 获得了 1 枚“瑞平”标记");
				}
			}
		} elseif ($subAction === 'skill_zhipai' && $isMyTurn && $state['phase'] === 'PLAY' && empty($state['pending_response']) && $curr['general']['name'] === 'Gary0') {
			$tIdx = getPlayerIndexByUid($state, $targetUid);
			if ($tIdx !== -1 && $tIdx !== (int)$state['turn_index'] && !$state['players'][$tIdx]['dead'] && $state['players'][$tIdx]['marks']['ruiping'] > 0) {
				$tp = &$state['players'][$tIdx];
				$markCnt = (int)$tp['marks']['ruiping'];
				$tp['marks']['ruiping'] = 0;
				addLog($state, "<span style='color:#e74c3c;font-weight:bold;'>【制牌】</span> <strong>{$curr['name']}</strong> 对 <strong>{$tp['name']}</strong> 使用了 lycuim 制牌！其失去了 {$markCnt} 个“瑞平”标记，<strong>{$curr['name']}</strong> 开始排列其手牌...");
				$state['pending_response'] = [
					'type' => 'zhipai_arrange',
					'from_uid' => $curr['uid'],
					'from_name' => $curr['name'],
					'target_uid' => $tp['uid'],
					'target_name' => $tp['name']
				];
			} else {
				echo json_encode(['success' => false, 'msg' => '目标必须是拥有“瑞平”标记的其他角色']);
				exit;
			}
		} elseif ($subAction === 'zhipai_confirm') {
			$resp = $state['pending_response'];
			if ($resp && $resp['type'] === 'zhipai_arrange' && (int)$resp['from_uid'] === $login_uid) {
				$state['pending_response'] = null;
				$tIdx = getPlayerIndexByUid($state, $resp['target_uid']);
				if ($tIdx === -1 || $state['players'][$tIdx]['dead']) {
					addLog($state, "<span style='color:#e74c3c;font-weight:bold;'>【制牌】</span> 目标已阵亡，制牌无效...");
				} else {
					$tp = &$state['players'][$tIdx];
					$cids = json_decode($_POST['card_cids'] ?? '[]', true);
					if (!is_array($cids)) $cids = [];
					$cids = array_values(array_unique($cids));
					$byCid = [];
					foreach ($tp['hand'] as $c) $byCid[$c['cid']] = $c;
					$insertList = [];
					foreach ($cids as $cidKey) {
						if (isset($byCid[$cidKey])) {
							$insertList[] = $byCid[$cidKey];
							unset($byCid[$cidKey]);
						}
					}
					$restList = array_values($byCid);
					if (!empty($insertList)) {
						$state['deck'] = array_merge($state['deck'], array_reverse($insertList));
					}
					if (!empty($restList)) {
						$curr['hand'] = array_merge($curr['hand'], $restList);
					}
					$tp['hand'] = [];
					$wasFlipped = !empty($curr['flipped']);
					$curr['flipped'] = true;
					addLog($state, "<span style='color:#e74c3c;font-weight:bold;'>【制牌】</span> <strong>{$curr['name']}</strong> 将 <strong>{$tp['name']}</strong> 的 " . count($insertList) . " 张手牌插入了牌堆顶，获得了其余 " . count($restList) . " 张牌！" . (!$wasFlipped ? " 随后翻面！" : ''));
				}
			}
		} elseif ($subAction === 'skill_sajiao' && $isMyTurn && $state['phase'] === 'PLAY' && !$state['used_sajiao'] && empty($state['pending_response']) && $curr['general']['name'] === '小猫娘FR') {
			$state['used_sajiao'] = true;
			addLog($state, "<span style='color:#f39c12;font-weight:bold;'>【撒娇】</span> <strong>{$curr['name']}</strong> 进行了卖萌！场上所有角色（包括自己）需弃置 2 张手牌，否则受到 1 点伤害！");
			$targets = [];
			$pCount = count($state['players']);
			for ($i = 0; $i < $pCount; $i++) {
				$tIdx = ($state['turn_index'] + $i) % $pCount;
				if (!$state['players'][$tIdx]['dead']) {
					$targets[] = $state['players'][$tIdx]['uid'];
				}
			}
			if (!empty($targets)) {
				$state['pending_response'] = [
					'type' => 'aoe_sajiao',
					'from_uid' => $curr['uid'],
					'from_name' => $curr['name'],
					'targets' => $targets
				];
			}
		} elseif ($subAction === 'skill_tiaojiao' && $isMyTurn && $state['phase'] === 'PLAY' && !$state['used_tiaojiao'] && empty($state['pending_response']) && $curr['general']['name'] === 'Rabo') {
			if (!empty($state['no_tiaojiao_extra'])) {
				echo json_encode(['success' => false, 'msg' => '【控制】的额外回合内无法使用【调教】']);
				exit;
			}
			$tIdx = getPlayerIndexByUid($state, $targetUid);
			if ($tIdx !== -1 && !$state['players'][$tIdx]['dead']) {
				$state['used_tiaojiao'] = true;
				if (!isset($state['players'][$tIdx]['marks']['xiaomaoliang'])) {
					$state['players'][$tIdx]['marks']['xiaomaoliang'] = 0;
				}
				$state['players'][$tIdx]['marks']['xiaomaoliang']++;
				addLog($state, "<span style='color:#9b59b6;font-weight:bold;'>【调教】</span> <strong>{$curr['name']}</strong> 令 <strong>{$state['players'][$tIdx]['name']}</strong> 获得了 1 个“小猫梁”标记！");
			}
		} elseif ($subAction === 'skill_guanshui' && $isMyTurn && $state['phase'] === 'PLAY' && !$state['used_guanshui'] && empty($state['pending_response']) && $curr['general']['name'] === '小猫娘FR') {
			$state['used_guanshui'] = true;
			addLog($state, "<span style='color:#3498db;font-weight:bold;'>【灌水】限定技</span> <strong>{$curr['name']}</strong> 开始从所有其他玩家的手牌中挑选至多 4 张！");
			$state['pending_response'] = [
				'type' => 'guanshui_select',
				'from_uid' => $curr['uid'],
				'from_name' => $curr['name']
			];
		} elseif ($subAction === 'guanshui_confirm') {
			$resp = $state['pending_response'];
			if ($resp && $resp['type'] === 'guanshui_select' && (int)$resp['from_uid'] === $login_uid) {
				$state['pending_response'] = null;
				$cids = json_decode($_POST['card_cids'] ?? '[]', true);
				if (!is_array($cids)) $cids = [];
				$cids = array_values(array_unique($cids));
				if (count($cids) > 4) $cids = array_slice($cids, 0, 4);
				$chosen = [];
				$discardedTotal = 0;
				foreach ($state['players'] as &$p) {
					if (!$p['dead'] && $p['uid'] !== $curr['uid']) {
						foreach ($p['hand'] as $c) {
							$pos = array_search($c['cid'], $cids, true);
							if ($pos !== false && count($chosen) < 4) {
								$chosen[] = $c;
								unset($cids[$pos]);
							} else {
								$state['discard'][] = $c;
								$discardedTotal++;
							}
						}
						$p['hand'] = [];
					}
				}
				unset($p);
				if (!empty($chosen)) {
					$curr['hand'] = array_merge($curr['hand'], $chosen);
				}
				addLog($state, "<span style='color:#3498db;font-weight:bold;'>【灌水】限定技</span> <strong>{$curr['name']}</strong> 获得了 " . count($chosen) . " 张手牌，弃置了场上其余 {$discardedTotal} 张手牌，回合直接结束（跳过弃牌阶段）！");
				nextTurn($state);
			}
		} elseif ($subAction === 'skill_baolun' && $isMyTurn && $state['phase'] === 'PLAY' && !$state['used_baolun'] && empty($state['pending_response']) && $curr['general']['name'] === 'zhoumurui') {
			$trick = $_POST['trick'] ?? '';
			if (!in_array($trick, ['无中生有', '顺手牵羊', '过河拆桥', '决斗'], true)) {
				echo json_encode(['success' => false, 'msg' => '无效的锦囊牌']);
				exit;
			}
			if (!isset($curr['hand'][$cardIdx]) || $curr['hand'][$cardIdx]['name'] !== '杀') {
				echo json_encode(['success' => false, 'msg' => '请先选择一张【杀】']);
				exit;
			}
			$tIdx = getPlayerIndexByUid($state, $targetUid);
			if (in_array($trick, ['顺手牵羊', '过河拆桥', '决斗'], true) && ($tIdx === -1 || $state['players'][$tIdx]['dead'] || $state['players'][$tIdx]['uid'] === $curr['uid'])) {
				echo json_encode(['success' => false, 'msg' => '请选择一名其他角色作为目标']);
				exit;
			}
			if (in_array($trick, ['顺手牵羊', '过河拆桥'], true) && empty($state['players'][$tIdx]['hand'])) {
				echo json_encode(['success' => false, 'msg' => '目标没有手牌']);
				exit;
			}
			$state['used_baolun'] = true;
			$card = array_splice($curr['hand'], $cardIdx, 1)[0];
			$state['discard'][] = $card;
			addLog($state, "<span style='color:#16a085;font-weight:bold;'>【暴论】</span> <strong>{$curr['name']}</strong> 将一张【杀】当做【{$trick}】使用！");
			if ($trick === '无中生有') {
				$drawn = drawCardsFromState($state, 2);
				$curr['hand'] = array_merge($curr['hand'], $drawn);
				addLog($state, "<strong>{$curr['name']}</strong> 摸了 2 张牌");
			} elseif ($trick === '顺手牵羊') {
				$stolen = array_pop($state['players'][$tIdx]['hand']);
				$curr['hand'][] = $stolen;
				addLog($state, "<strong>{$curr['name']}</strong> 顺走了 <strong>{$state['players'][$tIdx]['name']}</strong> 的一张手牌");
			} elseif ($trick === '过河拆桥') {
				$removed = array_pop($state['players'][$tIdx]['hand']);
				$state['discard'][] = $removed;
				addLog($state, "<strong>{$curr['name']}</strong> 拆掉了 <strong>{$state['players'][$tIdx]['name']}</strong> 的一张手牌");
			} else {
				addLog($state, "<strong>{$curr['name']}</strong> 对 <strong>{$state['players'][$tIdx]['name']}</strong> 发起了【决斗】（造成的伤害将被防止）！");
				$state['pending_response'] = [
					'type' => 'duel_sha',
					'responder_uid' => $state['players'][$tIdx]['uid'],
					'responder_name' => $state['players'][$tIdx]['name'],
					'opponent_uid' => $curr['uid'],
					'opponent_name' => $curr['name'],
					'prevent_damage' => true
				];
			}
		} elseif ($subAction === 'respond_zichao_ask') {
			$resp = $state['pending_response'];
			if ($resp && $resp['type'] === 'zichao_ask' && (int)$resp['target_uid'] === $login_uid) {
				$state['pending_response'] = null;
				if ((bool) ($_POST['use'] ?? false)) {
					$myIdx = getPlayerIndexByUid($state, $login_uid);
					if ($myIdx !== -1 && !$state['players'][$myIdx]['dead']) {
						$drawn = 0;
						while (count($state['players'][$myIdx]['hand']) < (int)$resp['max_hand']) {
							$cards = drawCardsFromState($state, 1);
							if (empty($cards)) break;
							$state['players'][$myIdx]['hand'] = array_merge($state['players'][$myIdx]['hand'], $cards);
							$drawn++;
						}
						addLog($state, "<span style='color:#16a085;font-weight:bold;'>【自嘲】</span> <strong>{$state['players'][$myIdx]['name']}</strong> 从牌堆顶摸了 {$drawn} 张牌，手牌数达到 " . count($state['players'][$myIdx]['hand']) . " 张");
					}
				}
				nextTurn($state);
			}
		} elseif ($subAction === 'play_card' && $isMyTurn && $state['phase'] === 'PLAY' && empty($state['pending_response'])) {
			if (isset($curr['hand'][$cardIdx])) {
				$card = $curr['hand'][$cardIdx];
				if ($card['name'] === '杀' && $state['used_sha_this_turn']) {
					echo json_encode(['success' => false, 'msg' => '本回合已使用过【杀】']);
					exit;
				}
				if ($card['name'] === '桃' && $curr['hp'] >= $curr['maxHp']) {
					echo json_encode(['success' => false, 'msg' => '体力已满，无需使用【桃】']);
					exit;
				}
				array_splice($curr['hand'], $cardIdx, 1);
				$state['discard'][] = $card;

				if ($card['name'] === '桃') {
					$curr['hp'] = min($curr['maxHp'], $curr['hp'] + 1);
					addLog($state, "<strong>{$curr['name']}</strong> 使用了【桃】，恢复 1 点体力（当前HP: {$curr['hp']}/{$curr['maxHp']}）");
				} elseif ($card['name'] === '无中生有') {
					$drawn = drawCardsFromState($state, 2);
					$curr['hand'] = array_merge($curr['hand'], $drawn);
					addLog($state, "<strong>{$curr['name']}</strong> 使用了【无中生有】，摸了 2 张牌");
				} elseif ($card['name'] === '杀') {
					$state['used_sha_this_turn'] = true;
					$tIdx = getPlayerIndexByUid($state, $targetUid);
					if ($tIdx !== -1 && !$state['players'][$tIdx]['dead']) {
						addLog($state, "<strong>{$curr['name']}</strong> 对 <strong>{$state['players'][$tIdx]['name']}</strong> 使用了【杀】！等待其响应...");
						$state['pending_response'] = [
							'type' => 'respond_shan',
							'from_uid' => $curr['uid'],
							'from_name' => $curr['name'],
							'target_uid' => $state['players'][$tIdx]['uid'],
							'target_name' => $state['players'][$tIdx]['name']
						];
					}
				} elseif ($card['name'] === '决斗') {
					$tIdx = getPlayerIndexByUid($state, $targetUid);
					if ($tIdx !== -1 && !$state['players'][$tIdx]['dead']) {
						addLog($state, "<strong>{$curr['name']}</strong> 对 <strong>{$state['players'][$tIdx]['name']}</strong> 发起了【决斗】！");
						$state['pending_response'] = [
							'type' => 'duel_sha',
							'responder_uid' => $state['players'][$tIdx]['uid'],
							'responder_name' => $state['players'][$tIdx]['name'],
							'opponent_uid' => $curr['uid'],
							'opponent_name' => $curr['name']
						];
					}
				} elseif ($card['name'] === '顺手牵羊' || $card['name'] === '过河拆桥') {
					$tIdx = getPlayerIndexByUid($state, $targetUid);
					if ($tIdx !== -1 && !empty($state['players'][$tIdx]['hand'])) {
						$stolen = array_pop($state['players'][$tIdx]['hand']);
						if ($card['name'] === '顺手牵羊') {
							$curr['hand'][] = $stolen;
							addLog($state, "<strong>{$curr['name']}</strong> 顺走了 <strong>{$state['players'][$tIdx]['name']}</strong> 的一张手牌");
						} else {
							$state['discard'][] = $stolen;
							addLog($state, "<strong>{$curr['name']}</strong> 拆掉了 <strong>{$state['players'][$tIdx]['name']}</strong> 的一张手牌");
						}
					}
				}
			}
		} elseif ($subAction === 'end_turn' && $isMyTurn && $state['phase'] === 'PLAY' && empty($state['pending_response'])) {
			$needDiscard = count($curr['hand']) - $curr['hp'];
			if ($needDiscard > 0) {
				$state['phase'] = 'DISCARD';
				$state['discard_needed'] = $needDiscard;
				addLog($state, "<strong>{$curr['name']}</strong> 准备结束回合，需弃置 {$needDiscard} 张手牌");
			} else {
				askZichao($state);
			}
		}

		checkGameOver($state);
		$roomStatus = $state['status'] ?? 'playing';
		$stateJson = $conn->real_escape_string(json_encode($state, JSON_UNESCAPED_UNICODE));
		$conn->query("UPDATE lolmtoj_rooms SET status = '$roomStatus', game_state = '$stateJson', version = version + 1 WHERE id = $roomId");
		echo json_encode(['success' => true]);
		exit;
	}

	if ($api === 'send_chat') {
		$roomId = (int) $_POST['room_id'];
		$msg = trim($_POST['msg'] ?? '');
		if (mb_strlen($msg) === 0 || mb_strlen($msg) > 500) {
			echo json_encode(['success' => false, 'msg' => '消息不能为空且不超过500字']);
			exit;
		}

		$recent = $conn->query("SELECT COUNT(*) as cnt FROM lolmtoj_chat WHERE uid = $login_uid AND created_at > NOW() - INTERVAL 30 SECOND")->fetch_assoc()['cnt'];
		if ($recent >= 5) {
			echo json_encode(['success' => false, 'msg' => '发送太频繁，请稍后再试']);
			exit;
		}

		$stmt = $conn->prepare("INSERT INTO lolmtoj_chat (room_id, uid, name, msg) VALUES (?, ?, ?, ?)");
		$stmt->bind_param("iiss", $roomId, $login_uid, $login_name, $msg);
		$stmt->execute();
		$stmt->close();

		$conn->query("UPDATE lolmtoj_rooms SET version = version + 1 WHERE id = $roomId");
		echo json_encode(['success' => true]);
		exit;
	}
}
?>
<!DOCTYPE html>
<html lang="zh-CN">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>lmtoj杀</title>
	<style>
		:root {
			--bg: #f9f7f4;
			--card-bg: #ffffff;
			--nav-bg: #3d3a37;
			--nav-text: #f0ece6;
			--text: #2c2a28;
			--text-secondary: #7a736b;
			--text-muted: #a0988e;
			--border: #e6e1da;
			--border-light: #f0ece6;
			--accent: #6b8a74;
			--accent-hover: #55735e;
			--accent-light: #eef4ef;
			--gold: #d4af37;
			--danger: #d9534f;
			--radius: 10px;
			--shadow: 0 2px 10px rgba(0, 0, 0, 0.05);
			--font: 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
		}
		* { margin: 0; padding: 0; box-sizing: border-box; }
		body { background: var(--bg); font-family: var(--font); color: var(--text); line-height: 1.6; }
		.navbar { background: var(--nav-bg); height: 54px; display: flex; align-items: center; justify-content: space-between; padding: 0 28px; color: var(--nav-text); position: sticky; top: 0; z-index: 100; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
		.navbar h1 { font-size: 17px; font-weight: 600; color: #f0ece6; }
		.navbar h1 a { color: #f0ece6; text-decoration: none; }
		.user-info { display: flex; align-items: center; gap: 8px; font-size: 14px; }
		.user-info a { color: #e0dbd3; text-decoration: none; padding: 6px 12px; }
		.main { max-width: 1320px; margin: 20px auto 40px; display: flex; gap: 18px; padding: 0 14px; }
		.sidebar { background: var(--card-bg); border-radius: var(--radius); box-shadow: var(--shadow); width: fit-content; min-width: 120px; overflow: hidden; position: sticky; top: 80px; flex-shrink: 0; height: fit-content; }
		.sidebar a { display: block; padding: 13px 22px; text-align: center; color: var(--text); text-decoration: none; font-size: 14px; font-weight: 500; border-left: 3px solid transparent; }
		.sidebar a:hover, .sidebar a.active { background: #f5f2ed; border-left-color: var(--accent); color: var(--accent); }
		.content { flex: 1; min-width: 0; }
		.card { background: var(--card-bg); border-radius: var(--radius); padding: 22px; margin-bottom: 18px; box-shadow: var(--shadow); }
		.btn { padding: 7px 16px; background: var(--accent); color: #fff; border: none; border-radius: 18px; cursor: pointer; font-size: 13px; font-weight: 500; transition: 0.2s; display: inline-flex; align-items: center; gap: 6px; }
		.btn:hover { background: var(--accent-hover); }
		.btn:disabled { background: #bfbab0; cursor: not-allowed; }
		.btn-sm { padding: 4px 10px; font-size: 12px; border-radius: 14px; }
		.btn-gold { background: #c59b27; color: #fff; }
		.btn-gold:hover { background: #af861b; }
		.btn-info { background: #2980b9; color: #fff; }
		.btn-info:hover { background: #1c5980; }
		.btn-danger { background: var(--danger); }
		.btn-danger:hover { background: #c0392b; }
		.room-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 14px; margin-top: 14px; }
		.room-item { background: #fdfcfb; border: 1.5px solid var(--border); border-radius: 8px; padding: 14px; transition: 0.2s; }
		.room-item:hover { border-color: var(--accent); box-shadow: var(--shadow); }
		.room-item h4 { font-size: 15px; margin-bottom: 6px; color: #2c2a28; }
		.lolmtoj-arena-wrap { background: radial-gradient(circle at center, #2e261f 0%, #15120f 100%); border-radius: var(--radius); padding: 16px; color: #eee; border: 2px solid #5a4a35; user-select: none; display: flex; gap: 16px; }
		.my-general-bigcard { width: 275px; flex-shrink: 0; background: linear-gradient(180deg, #30261e, #1a1512); border: 2.5px solid #d4af37; border-radius: 12px; padding: 12px; display: flex; flex-direction: column; box-shadow: 0 4px 20px rgba(0, 0, 0, 0.6); }
		.big-portrait-wrap { width: 100%; height: 290px; border-radius: 8px; border: 2px solid #8c734b; overflow: hidden; position: relative; background: #000; }
		.big-portrait-wrap img { width: 100%; height: 100%; object-fit: cover; }
		.big-hp-bar { display: flex; align-items: center; justify-content: space-between; margin: 10px 0 6px; background: rgba(0, 0, 0, 0.5); padding: 6px 10px; border-radius: 6px; border: 1px solid #4a3b2b; }
		.hp-hearts { color: #e74c3c; font-size: 16px; letter-spacing: 2px; }
		.hp-hearts .lost { color: #555; }
		.skills-detail-box { flex: 1; background: rgba(0, 0, 0, 0.4); border-radius: 6px; padding: 8px; border: 1px solid #4a3b2b; font-size: 12px; line-height: 1.5; overflow-y: auto; max-height: 220px; }
		.skill-item-title { color: #f39c12; font-weight: bold; margin-top: 4px; }
		.arena-right-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 12px; }
		.opponents-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px; }
		.player-panel { background: linear-gradient(135deg, #2b241e, #1a1513); border: 2px solid #7a6341; border-radius: 8px; padding: 8px; display: flex; gap: 10px; transition: 0.25s; position: relative; }
		.player-panel.active-turn { border-color: #f1c40f; box-shadow: 0 0 12px rgba(241, 196, 15, 0.6); }
		.player-panel.targetable { border-color: #2ecc71 !important; cursor: pointer; animation: pulse-green 1.2s infinite; background: #1e3323 !important; }
		.player-panel.targetable::after { content: "点击指定"; position: absolute; top: 4px; right: 4px; background: #2ecc71; color: #000; font-size: 10px; font-weight: bold; padding: 1px 5px; border-radius: 4px; }
		.player-panel.flipped { filter: grayscale(70%) brightness(75%); }
		.player-panel.dead { opacity: 0.3; filter: grayscale(100%); pointer-events: none; }
		@keyframes pulse-green { 0%, 100% { box-shadow: 0 0 6px #2ecc71; transform: scale(1); } 50% { box-shadow: 0 0 16px #2ecc71; transform: scale(1.02); } }
		.opp-avatar-box { width: 65px; height: 90px; border-radius: 6px; border: 1.5px solid #d4af37; overflow: hidden; position: relative; background: #111; flex-shrink: 0; }
		.opp-avatar-box img { width: 100%; height: 100%; object-fit: cover; }
		.opp-badge-count { position: absolute; bottom: 0; right: 0; background: rgba(0, 0, 0, 0.85); color: #f5d76e; font-size: 10px; padding: 1px 4px; }
		.player-info { flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: space-between; font-size: 12px; }
		.p-hp { color: #2ecc71; font-weight: bold; font-size: 13px; }
		.p-marks { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 2px; }
		.mark-tag { font-size: 10px; padding: 1px 5px; border-radius: 8px; background: #8e44ad; color: #fff; }
		.battle-center { display: grid; grid-template-columns: 1fr 310px; gap: 12px; background: rgba(0, 0, 0, 0.35); border-radius: 8px; padding: 10px; min-height: 130px; }
		.logs-box { background: rgba(10, 8, 7, 0.85); border-radius: 6px; padding: 8px; font-size: 12px; height: 130px; overflow-y: auto; color: #bbb; border: 1px solid #44372a; line-height: 1.5; }
		.target-prompt-banner { background: #1e3b2b; border: 1.5px solid #2ecc71; border-radius: 6px; padding: 8px 12px; margin-bottom: 8px; display: flex; align-items: center; justify-content: space-between; color: #afffd0; font-size: 13px; animation: fadeIn 0.2s; }
		.respond-banner { background: #4a1515; border: 2px solid #e74c3c; border-radius: 6px; padding: 10px 14px; margin-bottom: 8px; display: flex; align-items: center; justify-content: space-between; color: #ffc5c5; font-size: 13.5px; }
		.dying-banner { background: #610d0d; border: 2.5px solid #ff4757; border-radius: 8px; padding: 12px 16px; margin-bottom: 8px; display: flex; align-items: center; justify-content: space-between; color: #fff; font-size: 14px; animation: pulse-red 1.2s infinite; }
		@keyframes pulse-red { 0%, 100% { box-shadow: 0 0 5px #ff4757; } 50% { box-shadow: 0 0 16px #ff4757; } }
		.discard-prompt-banner { background: #4a3515; border: 2px solid #f39c12; border-radius: 6px; padding: 10px 14px; margin-bottom: 8px; display: flex; align-items: center; justify-content: space-between; color: #ffe6b8; font-size: 13.5px; }
		.my-controls-wrap { background: linear-gradient(180deg, #2d241d, #191410); border: 2px solid #a68449; border-radius: 8px; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
		.handcards-bar { display: flex; gap: 8px; overflow-x: auto; padding: 6px 2px; min-height: 95px; align-items: flex-end; }
		.lolmtoj-card { width: 68px; height: 90px; background: #fdfbf7; color: #222; border-radius: 6px; border: 1.5px solid #bda885; padding: 4px; display: flex; flex-direction: column; justify-content: space-between; cursor: pointer; transition: 0.15s; flex-shrink: 0; }
		.lolmtoj-card:hover { transform: translateY(-10px); border-color: #f39c12; }
		.lolmtoj-card.selected { transform: translateY(-14px); border-color: #2ecc71; box-shadow: 0 0 10px #2ecc71; }
		.lolmtoj-card.discard-selected { transform: translateY(-14px); border-color: #e74c3c; box-shadow: 0 0 10px #e74c3c; background: #ffeaea; }
		.lolmtoj-card.red { color: #c0392b; }
		.lolmtoj-card.black { color: #111; }
		.general-picker { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin: 16px 0; }
		.gen-opt { background: #fbf9f6; border: 2px solid var(--border); border-radius: 8px; padding: 10px; cursor: pointer; text-align: center; transition: 0.2s; position: relative; }
		.gen-opt:hover, .gen-opt.active { border-color: var(--accent); background: var(--accent-light); }
		.gen-opt.disabled { opacity: 0.4; cursor: not-allowed; pointer-events: none; }
		.gen-opt-occupied-badge { position: absolute; top: 6px; right: 6px; background: rgba(231,76,60,0.9); color:#fff; font-size:10px; padding:1px 5px; border-radius:4px; }
		.gen-opt img { width: 100%; height: 160px; object-fit: cover; border-radius: 4px; margin-bottom: 6px; }
		.chat-panel { background: rgba(0, 0, 0, 0.6); border-radius: 8px; padding: 8px; border: 1px solid #5a4a35; margin-top: 10px; }
		.chat-messages-box { height: 120px; overflow-y: auto; font-size: 13px; color: #ddd; padding: 4px; }
		.chat-messages-box div { padding: 2px 0; border-bottom: 1px solid #2a1f18; }
		.chat-input-row { display: flex; gap: 6px; margin-top: 6px; }
		.chat-input-row input { flex: 1; background: #2a1f18; border: 1px solid #5a4a35; color: #fff; padding: 6px; border-radius: 4px; outline: none; }
		.chat-input-row input:focus { border-color: #d4af37; }
		.spectator-banner { background: #2c3e50; color: #ecf0f1; padding: 8px 14px; border-radius: 6px; font-size: 13px; margin-bottom: 8px; border: 1px solid #34495e; text-align: center; }
		@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
		@media (max-width: 900px) {
			.lolmtoj-arena-wrap { flex-direction: column; }
			.my-general-bigcard { width: 100%; height: auto; }
			.big-portrait-wrap { height: 200px; }
			.general-picker { grid-template-columns: repeat(2, 1fr); }
			.battle-center { grid-template-columns: 1fr; }
		}
	</style>
</head>
<body>
<?php
if (file_exists('navbar.php')) {
	include 'navbar.php';
} else {
?>
<div class="navbar">
	<h1><a href="https://lmtoj.cn/">lmtoj杀</a></h1>
	<div class="user-info">
		<span><?= htmlspecialchars($login_name) ?></span>
		<a href="https://lmtoj.cn/">返回首页</a>
	</div>
</div>
<?php } ?>

<div class="main">
	<div class="sidebar">
		<a href="https://lmtoj.cn/">主页</a>
		<a href="/lolmtoj" class="active">lmtoj杀</a>
		<a href="/lolmtoj/stats">数据榜</a>
	</div>
	<div class="content">
		<div class="card" id="view-lobby">
			<div style="display:flex; justify-content:space-between; align-items:center;">
				<h2 style="font-size:18px;">大厅</h2>
				<button class="btn btn-gold" onclick="openCreateModal()">+ 创建房间</button>
			</div>
			<div class="room-grid" id="rooms-container"></div>
		</div>

		<div class="card" id="view-room" style="display:none;">
			<div style="display:flex; justify-content:space-between; align-items:center;">
				<h2 id="room-title-text" style="font-size:18px;">房间准备中</h2>
				<div>
					<button class="btn btn-danger" onclick="leaveRoom()">退出房间</button>
					<button class="btn btn-gold" id="btn-start-game" style="display:none;" onclick="startGame()">开始游戏</button>
				</div>
			</div>
			<div id="spectator-join-box" style="display:none; margin-top:12px;">
				<button class="btn btn-info" onclick="joinFromSpectate()">加入此房间</button>
			</div>
			<div style="margin-top:16px;" id="general-select-wrap">
				<h4 style="font-size:14px; margin-bottom:8px;">选择出战武将：</h4>
				<div class="general-picker">
					<?php foreach ($GENERALS_CONFIG as $genId => $gen) : ?>
						<div class="gen-opt" onclick="pickGeneral(<?= $genId ?>)" id="g-opt-<?= $genId ?>">
							<img src="<?= htmlspecialchars($gen['avatar']) ?>">
							<div style="font-weight:bold;"><?= htmlspecialchars($gen['name']) ?> (体力: <?= (int) $gen['hp'] ?>)</div>
							<div style="font-size:11px; color:#666;"><?= htmlspecialchars(implode('', array_map(function ($s) {
								return '【' . $s['name'] . '】';
							}, $gen['skills']))) ?></div>
						</div>
					<?php endforeach; ?>
				</div>
			</div>
			<div style="margin-top:14px; display:flex; justify-content:space-between; align-items:center;" id="ready-btn-wrap">
				<button class="btn" id="btn-ready-toggle" onclick="toggleReady()">准备</button>
			</div>
			<h4 style="font-size:14px; margin:16px 0 8px;">当前玩家列表：</h4>
			<div id="room-players-list" style="display:flex; gap:12px; flex-wrap:wrap;"></div>

			<div class="chat-panel" style="margin-top:20px; background:#241d18; border-color:#8c734b;">
				<div class="chat-messages-box" id="chat-messages-prep"></div>
				<div class="chat-input-row">
					<input type="text" id="chat-input-prep" placeholder="输入聊天内容..." maxlength="500">
					<button class="btn" onclick="sendChat('chat-input-prep')">发送</button>
				</div>
			</div>
		</div>

		<div class="lolmtoj-arena-wrap" id="view-game" style="display:none;">
			<div class="my-general-bigcard" id="my-bigcard-panel"></div>
			<div class="arena-right-main">
				<div style="display:flex; justify-content:space-between; align-items:center; background:rgba(0,0,0,0.4); padding:8px 12px; border-radius:6px; border:1px solid #5a4a35;">
					<div style="font-weight:bold; color:#f1c40f;" id="game-room-header-title">lmtoj杀对局</div>
					<div id="game-top-buttons"></div>
				</div>
				<div id="spectator-indicator" class="spectator-banner" style="display:none;">您当前正在观战此对局</div>
				<div class="opponents-row" id="opponents-container"></div>
				<div id="action-prompt-area"></div>
				<div class="battle-center">
					<div style="display:flex; flex-direction:column; justify-content:center; align-items:center;">
						<div id="game-status-tip" style="color:#f1c40f; font-weight:bold; font-size:15px; margin-bottom:6px;">等待回合开始...</div>
						<div style="font-size:12px; color:#aaa;">实时战场 (牌库: <span id="deck-count-num">0</span>张)</div>
					</div>
					<div class="logs-box" id="battle-logs-box"></div>
				</div>
				<div class="my-controls-wrap" id="player-controls-wrap">
					<div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
						<button class="btn btn-gold" id="btn-play" onclick="onPlayCard()">出牌</button>
						<button class="btn" id="btn-end" onclick="onEndTurn()">结束回合</button>
						<div id="my-skill-btns" style="display:inline-flex; gap:6px;"></div>
					</div>
					<div>
						<div style="font-size:12px; color:#aaa; margin-bottom:4px;">我的手牌:</div>
						<div class="handcards-bar" id="my-handcards"></div>
					</div>
				</div>
				<div class="chat-panel">
					<div class="chat-messages-box" id="chat-messages"></div>
					<div class="chat-input-row">
						<input type="text" id="chat-input" placeholder="输入聊天内容..." maxlength="500">
						<button class="btn" onclick="sendChat('chat-input')">发送</button>
					</div>
				</div>
			</div>
		</div>
	</div>
</div>

<script>
let currentRoomId = null;
let currentVersion = 0;
let pollTimer = null;
let selectedGeneralId = 0;
let isReady = 0;
let myUid = <?= $login_uid ?>;
let isSpectatorMode = false;
let selectedCardIdx = null;
let selectedDiscardIndices = [];
let guanshuiPicks = [];
let zhipaiPicks = [];
let baolunTrick = null;
let targetMode = null;
let targetModePrompt = '';
let _captcha_shown = false;
const GENERALS_MAP = { 1: 'Ydch', 2: '六面体', 3: 'Gary0', 4: '小猫娘FR', 5: 'Rabo', 7: 'zhoumurui' };

function loadRooms() {
	fetch('/lolmtoj', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: 'api_action=get_rooms'
	}).then(r => r.json()).then(res => {
		if (!res.success) return;
		const box = document.getElementById('rooms-container');
		box.innerHTML = '';
		if (res.rooms.length === 0) {
			box.innerHTML = '<div style="color:var(--text-muted); font-size:13px;">暂无对战房间，快来创建第一个吧！</div>';
			return;
		}
		res.rooms.forEach(rm => {
			let div = document.createElement('div');
			div.className = 'room-item';
			const notWaiting = rm.status !== 'waiting';
			const isFull = parseInt(rm.current_players) >= parseInt(rm.max_players);
			let actionBtn = '';
			if (notWaiting || isFull) {
				actionBtn = `<button class="btn btn-info btn-sm" onclick="enterRoom(${rm.id})">观战</button>`;
			} else {
				actionBtn = `<button class="btn btn-sm" onclick="joinRoom(${rm.id})">进入房间</button>`;
			}
			div.innerHTML = `
				<h4>${escapeHtml(rm.title)}</h4>
				<div style="font-size:12px; color:var(--text-muted); margin-bottom:4px;">房主: ${escapeHtml(rm.host_name)} | 人数: ${rm.current_players}/${rm.max_players} (${(rm.status === 'playing') ? '进行中' : (rm.status === 'waiting' ? '等待中' : '已结束')})</div>
				<div style="font-size:11px; color:#888; margin-bottom:8px;">创建时间: ${rm.created_at}</div>
				${actionBtn}
			`;
			box.appendChild(div);
		});
	});
}

function openCreateModal() {
	let title = prompt("请输入房间名称：", "小猫娘FR好可爱");
	if (!title) return;
	let maxP = prompt("请输入房间人数 (2-6)：", "6");
	if (!maxP) maxP = 6;
	fetch('/lolmtoj', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: `api_action=create_room&title=${encodeURIComponent(title)}&max_players=${maxP}`
	}).then(r => r.json()).then(res => {
		if (res.success) enterRoom(res.room_id);
		else alert(res.msg || '创建失败');
	});
}

function joinRoom(id) {
	fetch('/lolmtoj', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: `api_action=join_room&room_id=${id}`
	}).then(r => r.json()).then(res => {
		enterRoom(id);
	});
}

function joinFromSpectate() {
	if (!currentRoomId) return;
	joinRoom(currentRoomId);
}

function enterRoom(roomId) {
	currentRoomId = roomId;
	currentVersion = 0;
	window.history.replaceState({}, '', `/lolmtoj/${roomId}`);
	document.getElementById('view-lobby').style.display = 'none';
	startPolling();
}

function exitToLobby() {
	clearInterval(pollTimer);
	currentRoomId = null;
	currentVersion = 0;
	selectedGeneralId = 0;
	isReady = 0;
	isSpectatorMode = false;
	window.history.replaceState({}, '', '/lolmtoj');
	document.getElementById('view-lobby').style.display = 'block';
	document.getElementById('view-room').style.display = 'none';
	document.getElementById('view-game').style.display = 'none';
	loadRooms();
}

function leaveRoom() {
	if (!currentRoomId) return;
	fetch('/lolmtoj', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: `api_action=leave_room&room_id=${currentRoomId}`
	}).then(r => r.json()).then(res => {
		if (res.success) {
			exitToLobby();
		} else {
			alert(res.msg || '退出失败');
		}
	}).catch(() => {
		exitToLobby();
	});
}

function surrenderGame() {
	if (!confirm('确定要认输吗？认输后将直接阵亡。')) return;
	sendAction('surrender');
}

function kickPlayer(uid) {
	if (!confirm('确定要将该玩家移出房间吗？')) return;
	fetch('/lolmtoj', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: `api_action=kick_player&room_id=${currentRoomId}&target_uid=${uid}`
	}).then(r => r.json()).then(res => {
		if (!res.success) alert(res.msg || '踢人失败');
	});
}

function pickGeneral(gid) {
	if (selectedGeneralId === gid || isSpectatorMode) return;
	fetch('/lolmtoj', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: `api_action=update_prep&room_id=${currentRoomId}&general_id=${gid}&is_ready=${isReady}`
	}).then(r => r.json()).then(res => {
		if (res.success) {
			selectedGeneralId = gid;
			for (const key of Object.keys(GENERALS_MAP)) {
				const el = document.getElementById(`g-opt-${key}`);
				if (el) el.classList.toggle('active', parseInt(key) === gid);
			}
		} else {
			alert(res.msg || '选择失败');
		}
	});
}

function toggleReady() {
	if (selectedGeneralId <= 0) {
		alert('请先选择出战武将！');
		return;
	}
	const nextReady = isReady ? 0 : 1;
	fetch('/lolmtoj', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: `api_action=update_prep&room_id=${currentRoomId}&general_id=${selectedGeneralId}&is_ready=${nextReady}`
	}).then(r => r.json()).then(res => {
		if (res.success) {
			isReady = nextReady;
			document.getElementById('btn-ready-toggle').innerText = isReady ? '取消准备' : '准备';
		} else {
			alert(res.msg || '更新准备状态失败');
		}
	});
}

function startGame() {
	fetch('/lolmtoj', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: `api_action=start_game&room_id=${currentRoomId}`
	}).then(r => r.json()).then(res => {
		if (!res.success) alert(res.msg);
	});
}

function startPolling() {
	clearInterval(pollTimer);
	const poll = () => {
		if (!currentRoomId) return;
		fetch('/lolmtoj', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: `api_action=poll_state&room_id=${currentRoomId}&version=${currentVersion}`
		}).then(r => r.json()).then(data => {
			if (!data.success) {
				alert(data.msg || '房间已结束');
				exitToLobby();
				return;
			}
			if (!data.changed) return;
			currentVersion = data.version;
			isSpectatorMode = !!data.is_spectator;
			if (data.chat_messages) renderChat(data.chat_messages);

			if (data.room.status === 'waiting') {
				renderWaitingRoom(data);
			} else if (data.room.status === 'playing' || data.room.status === 'finished') {
				window._currentGameState = data.game_state;
				renderGame(data.game_state, isSpectatorMode, data.room);
				if (data.game_state && data.game_state.captcha && !isSpectatorMode) {
					handleCaptcha(data.game_state);
				}
			}
		}).catch(err => console.error(err));
	};
	pollTimer = setInterval(poll, 5000);
	poll();
}

function renderWaitingRoom(data) {
	if (!isSpectatorMode && !data.room_players.some(p => parseInt(p.uid) === myUid)) {
		alert('您已被房主移出房间');
		exitToLobby();
		return;
	}

	document.getElementById('view-room').style.display = 'block';
	document.getElementById('view-game').style.display = 'none';
	document.getElementById('room-title-text').innerText = `${data.room.title} (人数: ${data.room_players.length}/${data.room.max_players})`;

	const isHost = data.room.host_uid == myUid;
	document.getElementById('btn-start-game').style.display = isHost ? 'inline-flex' : 'none';

	if (isSpectatorMode) {
		document.getElementById('general-select-wrap').style.display = 'none';
		document.getElementById('ready-btn-wrap').style.display = 'none';
		document.getElementById('spectator-join-box').style.display = (data.room_players.length < data.room.max_players) ? 'block' : 'none';
	} else {
		document.getElementById('general-select-wrap').style.display = 'block';
		document.getElementById('ready-btn-wrap').style.display = 'block';
		document.getElementById('spectator-join-box').style.display = 'none';
		document.getElementById('btn-ready-toggle').style.display = isHost ? 'none' : 'inline-flex';
	}

	const occupiedMap = {};
	const myRecord = data.room_players.find(p => p.uid == myUid);
	if (myRecord) {
		selectedGeneralId = parseInt(myRecord.general_id) || 0;
		isReady = parseInt(myRecord.is_ready) || 0;
		document.getElementById('btn-ready-toggle').innerText = isReady ? '取消准备' : '准备';
	}

	data.room_players.forEach(p => {
		if (p.uid != myUid && parseInt(p.general_id) > 0) {
			occupiedMap[p.general_id] = p.name;
		}
	});

	for (const key of Object.keys(GENERALS_MAP)) {
		const i = parseInt(key);
		const el = document.getElementById(`g-opt-${key}`);
		if (!el) continue;
		el.classList.toggle('active', selectedGeneralId === i);
		const oldBadge = el.querySelector('.gen-opt-occupied-badge');
		if (oldBadge) oldBadge.remove();
		if (occupiedMap[i]) {
			el.classList.add('disabled');
			let b = document.createElement('span');
			b.className = 'gen-opt-occupied-badge';
			b.innerText = `${occupiedMap[i]} 已选`;
			el.appendChild(b);
		} else {
			el.classList.remove('disabled');
		}
	}

	const pBox = document.getElementById('room-players-list');
	pBox.innerHTML = '';
	data.room_players.forEach(p => {
		let el = document.createElement('div');
		el.style.cssText = 'padding:10px 14px; background:#faf8f5; border:1px solid #e0dbd3; border-radius:6px; font-size:13px; display:flex; align-items:center; gap:8px;';
		const isPlayerHost = p.uid == data.room.host_uid;
		const gName = p.general_id > 0 ? (GENERALS_MAP[p.general_id] || '未知') : '<span style="color:#999;">未选武将</span>';

		let statusBadge = '';
		if (isPlayerHost) {
			statusBadge = '<span style="color:#d4af37; font-weight:bold;">[房主]</span>';
		} else {
			statusBadge = (p.is_ready === '1') ? '<span style="color:#2ecc71; font-weight:bold;">已准备</span>' : '<span style="color:#e74c3c;">未准备</span>';
		}

		let kickBtn = '';
		if (isHost && !isPlayerHost) {
			kickBtn = `<button class="btn btn-danger btn-sm" style="padding:2px 8px; font-size:11px;" onclick="kickPlayer(${p.uid})">踢出</button>`;
		}

		el.innerHTML = `<span><strong>${escapeHtml(p.name)}</strong> (${gName}) - ${statusBadge}</span>${kickBtn}`;
		pBox.appendChild(el);
	});
}

function renderGame(state, isSpectator = false, room = {}) {
	document.getElementById('view-room').style.display = 'none';
	document.getElementById('view-game').style.display = 'flex';
	const currPlayer = state.players[state.turn_index];
	const isMyTurn = (!isSpectator && currPlayer.uid === myUid);
	const my = state.players.find(p => p.uid === myUid);

	const isGameFinished = (state.status === 'finished');
	const topBtns = document.getElementById('game-top-buttons');
	if (isSpectator) {
		topBtns.innerHTML = `<button class="btn btn-danger btn-sm" onclick="leaveRoom()">退出观战</button>`;
	} else if (isGameFinished || (my && my.dead)) {
		topBtns.innerHTML = `<button class="btn btn-danger btn-sm" onclick="leaveRoom()">返回大厅</button>`;
	} else {
		topBtns.innerHTML = `<button class="btn btn-danger btn-sm" onclick="surrenderGame()">认输</button>`;
	}

	document.getElementById('deck-count-num').innerText = state.deck ? state.deck.length : 0;
	document.getElementById('spectator-indicator').style.display = isSpectator ? 'block' : 'none';
	document.getElementById('player-controls-wrap').style.display = (isSpectator || (my && my.dead) || isGameFinished) ? 'none' : 'flex';

	const bigCard = document.getElementById('my-bigcard-panel');
	if (isSpectator || !my) {
		bigCard.style.display = 'none';
	} else {
		bigCard.style.display = 'flex';
		let heartsHtml = '';
		for (let i = 1; i <= my.maxHp; i++) {
			heartsHtml += (i <= my.hp) ? '♥ ' : '<span class="lost">♥ </span>';
		}
		bigCard.innerHTML = `
			<div class="big-portrait-wrap"><img src="${my.general.avatar}"></div>
			<div class="big-hp-bar">
				<div><strong style="color:#f5d76e; font-size:16px;">${escapeHtml(my.name)}</strong> <span style="font-size:12px; color:#aaa;">(${my.general.name})</span></div>
				<div class="hp-hearts">${heartsHtml}</div>
			</div>
			<div style="display:flex; gap:6px; flex-wrap:wrap; margin-bottom:8px;">
				${my.marks.xinxin ? `<span class="mark-tag">信心 ×${my.marks.xinxin}</span>` : ''}
				${my.marks.ruiping ? `<span class="mark-tag" style="background:#d35400;">瑞平 ×${my.marks.ruiping}</span>` : ''}
				${my.marks.xiaomaoliang ? `<span class="mark-tag" style="background:#8e44ad;">小猫梁 ×${my.marks.xiaomaoliang}</span>` : ''}
				${my.flipped ? `<span class="mark-tag" style="background:#777;">已翻面 (跳过下回合)</span>` : ''}
			</div>
			<div class="skills-detail-box">
				<div style="font-weight:bold; color:#f1c40f; border-bottom:1px solid #44372a; padding-bottom:3px; margin-bottom:4px;">武将技能详情</div>
				${my.general.skills.map(s => `
					<div class="skill-item-title">[${s.type}] ${s.name}</div>
					<div style="color:#bbb;">${s.desc}</div>
				`).join('')}
			</div>
		`;
	}

	const logBox = document.getElementById('battle-logs-box');
	logBox.innerHTML = state.logs.map(l => `<p>${l}</p>`).join('');
	logBox.scrollTop = logBox.scrollHeight;

	let statusText = `当前回合：<strong>${currPlayer.name}</strong>`;
	if (isGameFinished) {
		statusText = `<strong>对局已结束</strong>`;
	} else if (state.pending_response) {
		if (state.pending_response.type === 'dying_rescue') {
			statusText = `濒死求桃！等待打出【桃】救援 <strong>${state.pending_response.target_name}</strong>...`;
		} else if (state.pending_response.type === 'respond_shan') {
			statusText = `等待 <strong>${state.pending_response.target_name}</strong> 响应【闪】...`;
		} else if (state.pending_response.type === 'duel_sha') {
			statusText = `决斗中！等待 <strong>${state.pending_response.responder_name}</strong> 出【杀】...`;
		} else if (state.pending_response.type === 'aoe_nanman') {
			const curTargetUid = state.pending_response.targets[0];
			const curTargetObj = state.players.find(p => p.uid === curTargetUid);
			const curTargetName = curTargetObj ? curTargetObj.name : '玩家';
			statusText = `【南蛮入侵】进行中！等待 <strong>${curTargetName}</strong> 响应【杀】...`;
		} else if (state.pending_response.type === 'aoe_sajiao') {
			const curTargetUid = state.pending_response.targets[0];
			const curTargetObj = state.players.find(p => p.uid === curTargetUid);
			const curTargetName = curTargetObj ? curTargetObj.name : '玩家';
			statusText = `【撒娇】进行中！等待 <strong>${curTargetName}</strong> 弃置 2 张手牌或受到 1 点伤害...`;
		} else if (state.pending_response.type === 'ruiping_discard') {
			statusText = `等待 <strong>${state.pending_response.target_name}</strong> 弃置 2 张手牌...`;
		} else if (state.pending_response.type === 'xiemi_give') {
			statusText = `【泄密】<strong>${escapeHtml(state.pending_response.actor_name || currPlayer.name)}</strong> 必须将一张手牌交给 <strong>${escapeHtml(state.pending_response.target_name)}</strong>...`;
		} else if (state.pending_response.type === 'guanshui_select') {
			statusText = `【灌水】<strong>${escapeHtml(state.pending_response.from_name)}</strong> 正在从场上手牌中挑选至多 4 张...`;
		} else if (state.pending_response.type === 'zhipai_arrange') {
			statusText = `【制牌】<strong>${escapeHtml(state.pending_response.from_name)}</strong> 正在排列 <strong>${escapeHtml(state.pending_response.target_name)}</strong> 的手牌...`;
		} else if (state.pending_response.type === 'zichao_ask') {
			statusText = `结束阶段：<strong>${escapeHtml(state.pending_response.target_name)}</strong> 可以发动【自嘲】（摸牌至 ${state.pending_response.max_hand} 张）...`;
		}
	} else if (state.phase === 'DISCARD') {
		statusText = `<strong>${currPlayer.name}</strong> 正在弃牌...`;
	} else if (state.phase === 'JIJIANG_SELECT') {
		statusText = `Ydch 的【信心】：选择一名其他角色转移“信心”标记并造成 1 点伤害...`;
	}
	document.getElementById('game-status-tip').innerHTML = statusText;

	const promptArea = document.getElementById('action-prompt-area');
	promptArea.innerHTML = '';

	if (!isSpectator && my && !isGameFinished) {
		const selectedHandCard = (selectedCardIdx !== null && my.hand[selectedCardIdx]) ? my.hand[selectedCardIdx] : null;

		if (state.pending_response && state.pending_response.type === 'xiemi_give' && isMyTurn) {
			const isCardChosen = selectedCardIdx !== null && !!my.hand[selectedCardIdx];
			promptArea.innerHTML = `
				<div class="discard-prompt-banner">
					<div>【泄密】锁定技：必须将一张手牌交给“信心”标记最多的 <strong>${escapeHtml(state.pending_response.target_name)}</strong>（已选 ${isCardChosen ? 1 : 0} / 1）：</div>
					<div style="display:flex; gap:6px;">
						<button class="btn btn-gold" ${!isCardChosen ? 'disabled' : ''} onclick="sendXiemiGive()">交出所选手牌</button>
					</div>
				</div>
			`;
		} else if (state.pending_response && state.pending_response.type === 'zichao_ask' && state.pending_response.target_uid === myUid) {
			promptArea.innerHTML = `
				<div class="discard-prompt-banner">
					<div>结束阶段：是否发动【自嘲】？从牌堆顶重复摸牌，直到手牌数达到 <strong>${state.pending_response.max_hand}</strong> 张（除你以外手牌最多角色的手牌数，当前 ${my.hand.length} 张）：</div>
					<div style="display:flex; gap:6px;">
						<button class="btn btn-gold" onclick="sendZichaoResponse(true)">发动【自嘲】</button>
						<button class="btn btn-danger" onclick="sendZichaoResponse(false)">不发动</button>
					</div>
				</div>
			`;
		} else if (state.pending_response && state.pending_response.type === 'dying_rescue') {
			let isDyingMe = (state.pending_response.target_uid === myUid);
			let hasPeach = my.hand.some(c => c.name === '桃');
			let peachCount = my.hand.filter(c => c.name === '桃').length;
			let passedUids = state.pending_response.passed_uids || [];
			let hasPassed = passedUids.includes(myUid);
			let isCardPeachSelected = selectedHandCard && selectedHandCard.name === '桃';

			promptArea.innerHTML = `
				<div class="dying-banner">
					<div><strong>${state.pending_response.target_name}</strong> 处于濒死状态！(你有 ${peachCount} 张【桃】) 请选择一张【桃】使用或放弃：</div>
					<div style="display:flex; gap:8px;">
						<button class="btn btn-gold" ${!isCardPeachSelected || my.dead || hasPassed ? 'disabled' : ''} onclick="sendDyingPeach(true)">${isCardPeachSelected ? `打出[${selectedHandCard.suit}${selectedHandCard.num} 桃]` : (isDyingMe ? '选择【桃】自救' : '选择【桃】救人')}</button>
						<button class="btn btn-danger" ${hasPassed || my.dead ? 'disabled' : ''} onclick="sendDyingPeach(false)">${hasPassed ? '已放弃' : (isDyingMe ? '放弃自救' : '不救')}</button>
					</div>
				</div>
			`;
		} else if (state.pending_response && state.pending_response.type === 'respond_shan') {
			if (state.pending_response.target_uid === myUid) {
				let isCardShanSelected = selectedHandCard && selectedHandCard.name === '闪';
				promptArea.innerHTML = `
					<div class="respond-banner">
						<div><strong>${state.pending_response.from_name}</strong> 对你使用了【杀】！请从手牌中选择一张【闪】打出：</div>
						<div style="display:flex; gap:8px;">
							<button class="btn btn-gold" ${!isCardShanSelected ? 'disabled' : ''} onclick="sendShanResponse(true)">${isCardShanSelected ? `打出[${selectedHandCard.suit}${selectedHandCard.num} 闪]` : '请选择一张【闪】'}</button>
							<button class="btn btn-danger" onclick="sendShanResponse(false)">不出 (受到1点伤害)</button>
						</div>
					</div>
				`;
			}
		} else if (state.pending_response && state.pending_response.type === 'duel_sha') {
			if (state.pending_response.responder_uid === myUid) {
				let isCardShaSelected = selectedHandCard && selectedHandCard.name === '杀';
				promptArea.innerHTML = `
					<div class="respond-banner">
						<div><strong>${state.pending_response.opponent_name}</strong> 与你决斗！请从手牌中选择一张【杀】打出：</div>
						<div style="display:flex; gap:8px;">
							<button class="btn btn-gold" ${!isCardShaSelected ? 'disabled' : ''} onclick="sendDuelShaResponse(true)">${isCardShaSelected ? `打出[${selectedHandCard.suit}${selectedHandCard.num} 杀]` : '请选择一张【杀】'}</button>
							<button class="btn btn-danger" onclick="sendDuelShaResponse(false)">放弃 (受到1点伤害)</button>
						</div>
					</div>
				`;
			}
		} else if (state.pending_response && state.pending_response.type === 'aoe_nanman') {
			if (state.pending_response.targets.length > 0 && state.pending_response.targets[0] === myUid) {
				let isCardShaSelected = selectedHandCard && selectedHandCard.name === '杀';
				promptArea.innerHTML = `
					<div class="respond-banner">
						<div><strong>${state.pending_response.from_name}</strong> 发动了【南蛮入侵】！请选择一张【杀】响应：</div>
						<div style="display:flex; gap:8px;">
							<button class="btn btn-gold" ${!isCardShaSelected ? 'disabled' : ''} onclick="sendAoeNanmanResponse(true)">${isCardShaSelected ? `打出[${selectedHandCard.suit}${selectedHandCard.num} 杀]` : '请选择一张【杀】'}</button>
							<button class="btn btn-danger" onclick="sendAoeNanmanResponse(false)">不出 (受到1点伤害)</button>
						</div>
					</div>
				`;
			}
		} else if (state.pending_response && state.pending_response.type === 'aoe_sajiao') {
			if (state.pending_response.targets.length > 0 && state.pending_response.targets[0] === myUid) {
				promptArea.innerHTML = `
					<div class="respond-banner">
						<div><strong>${escapeHtml(state.pending_response.from_name)}</strong> 发动了【撒娇】卖萌！请选择：弃置 <strong>2</strong> 张手牌，或受到 <strong>1</strong> 点伤害（已选 ${selectedDiscardIndices.length} / 2）：</div>
						<div style="display:flex; gap:8px;">
							<button class="btn btn-gold" ${selectedDiscardIndices.length !== 2 ? 'disabled' : ''} onclick="sendAoeSajiaoResponse(true)">弃置两张手牌</button>
							<button class="btn btn-danger" onclick="sendAoeSajiaoResponse(false)">不弃牌 (受到1点伤害)</button>
						</div>
					</div>
				`;
			}
		} else if (state.pending_response && state.pending_response.type === 'guanshui_select' && isMyTurn) {
			const gsPool = state.pending_response.pool_view || [];
			const gsPoolHtml = gsPool.map(c => {
				const picked = guanshuiPicks.includes(c.cid);
				return `
					<div class="lolmtoj-card ${c.color} ${picked ? 'selected' : ''}" style="width:58px; height:76px;" onclick="toggleGuanshuiPick('${c.cid}')">
						<div style="display:flex; justify-content:space-between; font-size:10px; font-weight:bold;"><span>${c.suit}</span><span>${c.num}</span></div>
						<div style="text-align:center; font-weight:bold; font-size:12px; margin:auto 0;">${c.name}</div>
						<div style="text-align:right; font-size:8px; color:#888;">${escapeHtml(c.owner_name)}</div>
					</div>`;
			}).join('');
			promptArea.innerHTML = `
				<div class="discard-prompt-banner" style="display:block;">
					<div style="margin-bottom:6px;">【灌水】限定技：从所有其他玩家的手牌中任选 <strong>至多 4</strong> 张获得，其余全部弃置，随后你的回合直接结束（已选 ${guanshuiPicks.length} / 4）：</div>
					<div style="display:flex; gap:6px; overflow-x:auto; padding:4px 0; min-height:82px; align-items:flex-end;">${gsPoolHtml || '<span style="color:#999; font-size:12px;">场上其他玩家没有手牌</span>'}</div>
					<div style="margin-top:6px; display:flex; gap:6px; justify-content:flex-end;">
						<button class="btn btn-danger" onclick="sendGuanshuiConfirm()">确认灌水（获得所选 ${guanshuiPicks.length} 张，弃置其余并结束回合）</button>
					</div>
				</div>
			`;
		} else if (state.pending_response && state.pending_response.type === 'zhipai_arrange' && isMyTurn) {
			const zpPool = state.pending_response.pool_view || [];
			const zpTargetName = escapeHtml(state.pending_response.target_name);
			const zpPoolHtml = zpPool.map(c => {
				const order = zhipaiPicks.indexOf(c.cid);
				return `
					<div class="lolmtoj-card ${c.color} ${order >= 0 ? 'selected' : ''}" style="width:58px; height:76px; position:relative;" onclick="toggleZhipaiPick('${c.cid}')">
						${order >= 0 ? `<span style="position:absolute; top:2px; left:50%; transform:translateX(-50%); background:#2ecc71; color:#000; font-size:10px; font-weight:bold; padding:0 4px; border-radius:4px;">顶${order + 1}</span>` : ''}
						<div style="display:flex; justify-content:space-between; font-size:10px; font-weight:bold;"><span>${c.suit}</span><span>${c.num}</span></div>
						<div style="text-align:center; font-weight:bold; font-size:12px; margin:auto 0;">${c.name}</div>
					</div>`;
			}).join('');
			promptArea.innerHTML = `
				<div class="discard-prompt-banner" style="display:block;">
					<div style="margin-bottom:6px;">【制牌】：点击排列 <strong>${zpTargetName}</strong> 的手牌——所选按顺序插入牌堆顶（标注“顶1”的最先被摸到），<strong>未选中的牌全部由你获得</strong>，随后你翻面：</div>
					<div style="display:flex; gap:6px; overflow-x:auto; padding:4px 0; min-height:82px; align-items:flex-end;">${zpPoolHtml || '<span style="color:#999; font-size:12px;">目标没有手牌</span>'}</div>
					<div style="margin-top:6px; display:flex; gap:6px; justify-content:flex-end;">
						<button class="btn btn-gold" onclick="sendZhipaiConfirm()">确认制牌（${zhipaiPicks.length} 张插入牌堆顶，其余 ${zpPool.length - zhipaiPicks.length} 张你获得）</button>
					</div>
				</div>
			`;
		} else if (state.pending_response && state.pending_response.type === 'ruiping_discard') {
			if (state.pending_response.target_uid === myUid) {
				promptArea.innerHTML = `
					<div class="discard-prompt-banner">
						<div>受到【瑞平】影响，请勾选 <strong>2</strong> 张手牌并确认弃置（已选 ${selectedDiscardIndices.length} / 2）：</div>
						<button class="btn btn-danger" ${selectedDiscardIndices.length !== 2 ? 'disabled' : ''} onclick="sendRuipingDiscard()">确认弃牌</button>
					</div>
				`;
			}
		} else if (state.phase === 'DISCARD' && isMyTurn) {
			let needed = state.discard_needed;
			promptArea.innerHTML = `
				<div class="discard-prompt-banner">
					<div>手牌数大于体力上限，请勾选 <strong>${needed}</strong> 张手牌弃置（已选 ${selectedDiscardIndices.length} / ${needed}）：</div>
					<button class="btn btn-danger" ${selectedDiscardIndices.length !== needed ? 'disabled' : ''} onclick="sendConfirmDiscard()">确认弃牌</button>
				</div>
			`;
		} else if (targetMode === 'BAOLUN_CHOOSE') {
			const shaSelected = selectedCardIdx !== null && my.hand[selectedCardIdx] && my.hand[selectedCardIdx].name === '杀';
			const trickBtn = (name, cls) => `<button class="btn btn-sm ${cls}" ${!shaSelected ? 'disabled' : ''} onclick="chooseBaolunTrick('${name}')">当做【${name}】</button>`;
			promptArea.innerHTML = `
				<div class="discard-prompt-banner">
					<div>【暴论】：${shaSelected ? `已选中 [${my.hand[selectedCardIdx].suit}${my.hand[selectedCardIdx].num} 杀]` : '先点击手牌选中一张【杀】'}，再选择将其当做哪张锦囊牌使用（造成的伤害将被防止）：</div>
					<div style="display:flex; gap:6px; margin-top:6px; flex-wrap:wrap;">
						${trickBtn('无中生有', 'btn-gold')}
						${trickBtn('顺手牵羊', 'btn-info')}
						${trickBtn('过河拆桥', 'btn-info')}
						${trickBtn('决斗', 'btn-danger')}
						<button class="btn btn-sm" onclick="cancelTargetSelect()">取消</button>
					</div>
				</div>
			`;
		} else if (targetMode !== null) {
			promptArea.innerHTML = `
				<div class="target-prompt-banner">
					<div><strong>${targetModePrompt}</strong>（请点击上方高亮对手）</div>
					<button class="btn btn-danger btn-sm" onclick="cancelTargetSelect()">取消选择</button>
				</div>
			`;
		}
	}

	const oppBox = document.getElementById('opponents-container');
	oppBox.innerHTML = '';
	state.players.forEach(p => {
		if (!isSpectator && p.uid === myUid) return;
		let isTargetable = !isSpectator && targetMode !== null && targetMode !== 'BAOLUN_CHOOSE' && !p.dead && !isGameFinished;
		if (targetMode === 'SKILL_ZHIPAI' && p.marks.ruiping <= 0) isTargetable = false;
		if (targetMode === 'BAOLUN_TARGET' && (baolunTrick === '顺手牵羊' || baolunTrick === '过河拆桥') && !(p.hand_count > 0)) isTargetable = false;

		let div = document.createElement('div');
		div.className = `player-panel ${state.turn_index === state.players.indexOf(p) ? 'active-turn' : ''} ${isTargetable ? 'targetable' : ''} ${p.flipped ? 'flipped' : ''} ${p.dead ? 'dead' : ''}`;
		if (isTargetable) div.onclick = () => onSelectTarget(p.uid);
		div.innerHTML = `
			<div class="opp-avatar-box">
				<img src="${p.general.avatar}">
				<span class="opp-badge-count">手牌: ${p.hand_count}</span>
			</div>
			<div class="player-info">
				<div>
					<strong style="color:#f5d76e; font-size:13px;">${escapeHtml(p.name)}</strong> <span style="font-size:11px; color:#aaa;">(${p.general.name})</span>
					<div class="p-hp">HP: ${p.hp} / ${p.maxHp}</div>
					<div class="p-marks">
						${p.marks.xinxin ? `<span class="mark-tag">信心 ×${p.marks.xinxin}</span>` : ''}
						${p.marks.ruiping ? `<span class="mark-tag" style="background:#d35400;">瑞平 ×${p.marks.ruiping}</span>` : ''}
						${p.marks.xiaomaoliang ? `<span class="mark-tag" style="background:#8e44ad;">小猫梁 ×${p.marks.xiaomaoliang}</span>` : ''}
						${p.flipped ? `<span class="mark-tag" style="background:#666;">已翻面</span>` : ''}
					</div>
				</div>
			</div>
		`;
		oppBox.appendChild(div);
	});

	if (isSpectator || !my || isGameFinished) return;

	const btnBox = document.getElementById('my-skill-btns');
	btnBox.innerHTML = '';
	const canPlay = isMyTurn && state.phase === 'PLAY' && !state.pending_response;

	let isSelectedSha = (selectedCardIdx !== null && my.hand[selectedCardIdx] && my.hand[selectedCardIdx].name === '杀');
	let isSelectedPeach = (selectedCardIdx !== null && my.hand[selectedCardIdx] && my.hand[selectedCardIdx].name === '桃');
	let canPlayThisCard = canPlay && !(isSelectedSha && state.used_sha_this_turn) && !(isSelectedPeach && my.hp >= my.maxHp);

	document.getElementById('btn-play').disabled = !canPlayThisCard;
	document.getElementById('btn-end').disabled = !canPlay;

	if (!state.pending_response || state.pending_response.type !== 'guanshui_select') guanshuiPicks = [];
	if (!state.pending_response || state.pending_response.type !== 'zhipai_arrange') zhipaiPicks = [];

	if (my.general.name === 'Ydch') {
		if (state.phase === 'JIJIANG_SELECT' && isMyTurn) {
			targetMode = 'SKILL_JIJIANG';
			targetModePrompt = '【信心】：必须选择一名其他角色，将“信心”标记转移给该角色并对其造成 1 点伤害';
		}
	} else if (my.general.name === 'Gary0') {
		let b1 = document.createElement('button');
		b1.className = 'btn btn-gold';
		b1.innerText = '技能: 瑞平';
		b1.disabled = !canPlay || state.used_ruiping;
		b1.onclick = () => { targetMode = 'SKILL_RUIPING'; targetModePrompt = '【瑞平】：请选择一名角色（无标记→其获得 1 个“瑞平”标记；已有标记→其弃置 2 张手牌）'; renderGame(state, isSpectator); };
		btnBox.appendChild(b1);

		let hasMarkedOpponent = state.players.some(p => p.uid !== myUid && !p.dead && p.marks.ruiping > 0);
		let b2 = document.createElement('button');
		b2.className = 'btn btn-danger';
		b2.innerText = '技能: 制牌';
		b2.disabled = !canPlay || !hasMarkedOpponent;
		b2.title = '指定一名拥有“瑞平”标记的角色：其失去所有标记，你排列其全部手牌（若干张插到牌堆顶，其余你获得），随后若你未翻面则翻面';
		b2.onclick = () => { targetMode = 'SKILL_ZHIPAI'; targetModePrompt = '【制牌】：选择一名拥有“瑞平”标记的角色，其失去所有标记；其全部手牌由你排列（若干张插到牌堆顶，其余你获得），随后你翻面'; renderGame(state, isSpectator); };
		btnBox.appendChild(b2);
	} else if (my.general.name === '小猫娘FR') {
		let b1 = document.createElement('button');
		b1.className = 'btn btn-gold';
		b1.innerText = '技能: 撒娇';
		b1.disabled = !canPlay || state.used_sajiao;
		b1.onclick = () => sendAction('skill_sajiao');
		btnBox.appendChild(b1);

		let b2 = document.createElement('button');
		b2.className = 'btn btn-danger';
		b2.innerText = '限定技: 灌水';
		b2.disabled = !canPlay || state.used_guanshui;
		b2.onclick = () => sendAction('skill_guanshui');
		btnBox.appendChild(b2);
	} else if (my.general.name === 'Rabo') {
		let extraTurnBlock = !!(state.no_tiaojiao_extra && isMyTurn);
		let b1 = document.createElement('button');
		b1.className = 'btn btn-gold';
		b1.innerText = '技能: 调教';
		b1.disabled = !canPlay || state.used_tiaojiao || extraTurnBlock;
		if (extraTurnBlock) b1.title = '【控制】的额外回合内无法使用【调教】';
		b1.onclick = () => { targetMode = 'SKILL_TIAOJIAO'; targetModePrompt = '【调教】：请选择一名角色获得一个“小猫梁”标记'; renderGame(state, isSpectator); };
		btnBox.appendChild(b1);
	} else if (my.general.name === 'zhoumurui') {
		let b1 = document.createElement('button');
		b1.className = 'btn btn-gold';
		b1.innerText = '技能: 暴论';
		b1.disabled = !canPlay || state.used_baolun || !my.hand.some(c => c.name === '杀');
		b1.onclick = () => { targetMode = 'BAOLUN_CHOOSE'; renderGame(state, isSpectator); };
		btnBox.appendChild(b1);
	}

	const isDiscardMode = (state.phase === 'DISCARD' && isMyTurn) ||
		(state.pending_response && state.pending_response.type === 'ruiping_discard' && state.pending_response.target_uid === myUid) ||
		(state.pending_response && state.pending_response.type === 'aoe_sajiao' && state.pending_response.targets.length > 0 && state.pending_response.targets[0] === myUid);

	const handBox = document.getElementById('my-handcards');
	handBox.innerHTML = '';
	my.hand.forEach((c, idx) => {
		let el = document.createElement('div');
		let isSelected = selectedCardIdx === idx;
		let isDiscardSelected = selectedDiscardIndices.includes(idx);
		el.className = `lolmtoj-card ${c.color} ${isSelected ? 'selected' : ''} ${isDiscardSelected ? 'discard-selected' : ''}`;
		el.onclick = () => {
			if (isDiscardMode) {
				if (selectedDiscardIndices.includes(idx)) {
					selectedDiscardIndices = selectedDiscardIndices.filter(i => i !== idx);
				} else {
					const capAtTwo = !(state.phase === 'DISCARD' && isMyTurn && state.discard_needed > 2);
					if (capAtTwo && selectedDiscardIndices.length >= 2) {
						selectedDiscardIndices.shift();
					}
					selectedDiscardIndices.push(idx);
				}
			} else {
				selectedCardIdx = (selectedCardIdx === idx) ? null : idx;
			}
			renderGame(state, isSpectator);
		};
		el.innerHTML = `
			<div style="display:flex; justify-content:space-between; font-size:11px; font-weight:bold;">
				<span>${c.suit}</span><span>${c.num}</span>
			</div>
			<div style="text-align:center; font-weight:bold; font-size:13px; margin:auto 0;">${c.name}</div>
			<div style="text-align:right; font-size:9px; color:#888;">${c.type === 'basic' ? '基本' : '锦囊'}</div>
		`;
		handBox.appendChild(el);
	});
}

function handleCaptcha(state) {
	if (!state.captcha || _captcha_shown) return;
	const my = state.players.find(p => p.uid === myUid);
	if (!my || my.dead) return;
	const question = state.captcha.question;
	const answer = prompt("人机验证（请在30秒内作答）：" + question, "");
	if (answer === null) return;
	const numAnswer = parseInt(answer, 10);
	if (isNaN(numAnswer)) {
		alert("请输入数字！");
		return;
	}
	fetch('/lolmtoj', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: `api_action=game_action&room_id=${currentRoomId}&action_type=captcha_answer&answer=${numAnswer}`
	}).then(() => {
		_captcha_shown = false;
	});
	_captcha_shown = true;
}

function onPlayCard() {
	if (selectedCardIdx === null) { alert('请先点击选中一张手牌'); return; }
	const state = window._currentGameState;
	if (!state) { alert('无法获取当前状态'); return; }
	const my = state.players.find(p => p.uid === myUid);
	if (!my) return;
	const card = my.hand[selectedCardIdx];
	if (!card) return;
	if (card.name === '桃' || card.name === '无中生有') {
		sendAction('play_card', { target_uid: 0, card_index: selectedCardIdx });
		selectedCardIdx = null;
		return;
	}
	targetMode = 'PLAY_CARD';
	targetModePrompt = '请点击选择一名目标对手出牌';
	fetchStateAndRender();
}

function cancelTargetSelect() {
	targetMode = null;
	targetModePrompt = '';
	selectedCardIdx = null;
	selectedDiscardIndices = [];
	baolunTrick = null;
	fetchStateAndRender();
}

function onEndTurn() {
	targetMode = null;
	selectedCardIdx = null;
	selectedDiscardIndices = [];
	sendAction('end_turn');
}

function onSelectTarget(targetUid) {
	if (targetMode === 'PLAY_CARD') {
		sendAction('play_card', { target_uid: targetUid, card_index: selectedCardIdx });
	} else if (targetMode === 'SKILL_RUIPING') {
		sendAction('skill_ruiping', { target_uid: targetUid });
	} else if (targetMode === 'SKILL_ZHIPAI') {
		sendAction('skill_zhipai', { target_uid: targetUid });
	} else if (targetMode === 'SKILL_JIJIANG') {
		sendAction('skill_jijiang', { target_uid: targetUid });
	} else if (targetMode === 'SKILL_TIAOJIAO') {
		sendAction('skill_tiaojiao', { target_uid: targetUid });
	} else if (targetMode === 'BAOLUN_TARGET') {
		sendAction('skill_baolun', { card_index: selectedCardIdx, target_uid: targetUid, trick: baolunTrick });
	}
	targetMode = null;
	targetModePrompt = '';
	selectedCardIdx = null;
	baolunTrick = null;
}

function sendXiemiGive() {
	if (selectedCardIdx === null) return;
	sendAction('respond_xiemi_give', { card_index: selectedCardIdx });
	selectedCardIdx = null;
}

function sendZichaoResponse(use) {
	sendAction('respond_zichao_ask', { use: use ? 1 : 0 });
}

function chooseBaolunTrick(trick) {
	if (trick === '无中生有') {
		if (selectedCardIdx === null) return;
		sendAction('skill_baolun', { card_index: selectedCardIdx, target_uid: 0, trick: trick });
		selectedCardIdx = null;
		targetMode = null;
		return;
	}
	baolunTrick = trick;
	targetMode = 'BAOLUN_TARGET';
	targetModePrompt = `【暴论】：点击选择一名目标，将【杀】当做【${trick}】使用`;
	refreshRender();
}

function sendGuanshuiConfirm() {
	sendAction('guanshui_confirm', { card_cids: JSON.stringify(guanshuiPicks) });
	guanshuiPicks = [];
}

function sendZhipaiConfirm() {
	sendAction('zhipai_confirm', { card_cids: JSON.stringify(zhipaiPicks) });
	zhipaiPicks = [];
}

function toggleGuanshuiPick(cid) {
	const i = guanshuiPicks.indexOf(cid);
	if (i >= 0) guanshuiPicks.splice(i, 1);
	else if (guanshuiPicks.length < 4) guanshuiPicks.push(cid);
	refreshRender();
}

function toggleZhipaiPick(cid) {
	const i = zhipaiPicks.indexOf(cid);
	if (i >= 0) zhipaiPicks.splice(i, 1);
	else zhipaiPicks.push(cid);
	refreshRender();
}

function refreshRender() {
	if (window._currentGameState) renderGame(window._currentGameState, isSpectatorMode);
}

function sendDyingPeach(usePeach) {
	sendAction('respond_dying_peach', { use_peach: usePeach ? 1 : 0, card_index: selectedCardIdx !== null ? selectedCardIdx : -1 });
	selectedCardIdx = null;
}

function sendShanResponse(useShan) {
	sendAction('respond_shan', { use_shan: useShan ? 1 : 0, card_index: selectedCardIdx !== null ? selectedCardIdx : -1 });
	selectedCardIdx = null;
}

function sendDuelShaResponse(useSha) {
	sendAction('respond_duel_sha', { use_sha: useSha ? 1 : 0, card_index: selectedCardIdx !== null ? selectedCardIdx : -1 });
	selectedCardIdx = null;
}

function sendAoeNanmanResponse(useSha) {
	sendAction('respond_aoe_nanman', { use_sha: useSha ? 1 : 0, card_index: selectedCardIdx !== null ? selectedCardIdx : -1 });
	selectedCardIdx = null;
}

function sendAoeSajiaoResponse(useCard) {
	sendAction('respond_aoe_sajiao', { use_card: useCard ? 1 : 0, card_indices: JSON.stringify(selectedDiscardIndices) });
	selectedDiscardIndices = [];
}

function sendRuipingDiscard() {
	sendAction('respond_ruiping_discard', { card_indices: JSON.stringify(selectedDiscardIndices) });
	selectedDiscardIndices = [];
}

function sendConfirmDiscard() {
	sendAction('confirm_discard', { card_indices: JSON.stringify(selectedDiscardIndices) });
	selectedDiscardIndices = [];
}

function sendAction(type, extra = {}) {
	let body = `api_action=game_action&room_id=${currentRoomId}&action_type=${type}`;
	for (let k in extra) body += `&${k}=${extra[k]}`;
	fetch('/lolmtoj', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: body
	}).then(r => r.json()).then(res => {
		if (!res.success && res.msg) alert(res.msg);
		fetchStateAndRender();
	});
}

function fetchStateAndRender() {
	if (!currentRoomId) return;
	fetch('/lolmtoj', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: `api_action=poll_state&room_id=${currentRoomId}&version=0`
	}).then(r => r.json()).then(data => {
		if (data.success && data.game_state) {
			window._currentGameState = data.game_state;
			renderGame(data.game_state, !!data.is_spectator, data.room);
		}
	});
}

function escapeHtml(str) {
	let div = document.createElement('div');
	div.textContent = str || '';
	return div.innerHTML;
}

function renderChat(messages) {
	const boxes = [document.getElementById('chat-messages'), document.getElementById('chat-messages-prep')];
	const html = messages.map(m => `<div><span style="color:#f1c40f;">${escapeHtml(m.name)}</span> <span style="color:#aaa;">${m.time}</span>：${m.msg}</div>`).join('');
	boxes.forEach(box => {
		if (box) {
			box.innerHTML = html;
			box.scrollTop = box.scrollHeight;
		}
	});
}

function sendChat(inputId = 'chat-input') {
	const input = document.getElementById(inputId) || document.getElementById('chat-input');
	if (!input) return;
	const msg = input.value.trim();
	if (!msg) return;
	fetch('/lolmtoj', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: `api_action=send_chat&room_id=${currentRoomId}&msg=${encodeURIComponent(msg)}`
	}).then(r => r.json()).then(res => {
		if (res.success) {
			input.value = '';
		} else {
			alert(res.msg || '发送失败');
		}
	});
}

window._currentGameState = null;
document.addEventListener('DOMContentLoaded', function () {
	const inputInGame = document.getElementById('chat-input');
	if (inputInGame) inputInGame.addEventListener('keypress', e => { if (e.key === 'Enter') sendChat('chat-input'); });

	const inputInPrep = document.getElementById('chat-input-prep');
	if (inputInPrep) inputInPrep.addEventListener('keypress', e => { if (e.key === 'Enter') sendChat('chat-input-prep'); });

	const pathMatch = window.location.pathname.match(/\/lolmtoj\/(\d+)/);
	if (pathMatch && parseInt(pathMatch[1]) > 0) {
		enterRoom(parseInt(pathMatch[1]));
	} else {
		loadRooms();
	}
});
</script>
<?php
if (file_exists('footer.php')) {
	include 'footer.php';
}
?>
</body>
</html>
