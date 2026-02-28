// ── 機隊機場分類資料 ─────────────────────────────────────────────────
// 依據 Operations Specifications C-6 Authorized Airport List (Effective: JAN 30 2026)
// cls: 'r'=Regular, 'a'=Alternate, 'rs'=Regular+Special, 'as'=Alternate+Special
// P → 視為 A；P,S → 視為 A,S（RCKH/RCFN 等）

var _wxFleetData = {

// ════════════════════════════════════════════════════════════════════
// A321-252NX
// ════════════════════════════════════════════════════════════════════
'A321': {
  taiwan:      [{icao:'RCTP',name:'桃園',cls:'r'},{icao:'RCMQ',name:'台中',cls:'r'},{icao:'RCKH',name:'高雄',cls:'as'},{icao:'RCSS',name:'松山',cls:'as'},{icao:'RCFN',name:'台東',cls:'as'},{icao:'RCNN',name:'台南',cls:'a'}],
  hkmacao:     [{icao:'VHHH',name:'香港',cls:'rs'},{icao:'VMMC',name:'澳門',cls:'r'}],
  japan:       [{icao:'RJAA',name:'成田',cls:'r'},{icao:'RJBB',name:'關西',cls:'r'},{icao:'RJBE',name:'神戶',cls:'r'},{icao:'RJCC',name:'新千歲',cls:'r'},{icao:'RJCH',name:'函館',cls:'r'},{icao:'RJFF',name:'福岡',cls:'rs'},{icao:'RJFK',name:'鹿兒島',cls:'a'},{icao:'RJFT',name:'熊本',cls:'r'},{icao:'RJFU',name:'長崎',cls:'a'},{icao:'RJGG',name:'名古屋',cls:'r'},{icao:'RJNK',name:'小松',cls:'a'},{icao:'RJOS',name:'德島',cls:'a'},{icao:'RJOT',name:'高松',cls:'r'},{icao:'RJSN',name:'新潟',cls:'a'},{icao:'RJSS',name:'仙台',cls:'r'},{icao:'RJTT',name:'羽田',cls:'a'},{icao:'ROAH',name:'那霸',cls:'r'},{icao:'ROIG',name:'石垣',cls:'a'},{icao:'RORS',name:'下地島',cls:'r'}],
  korea:       [{icao:'RKPC',name:'濟州',cls:'a'},{icao:'RKPK',name:'釜山',cls:'rs'},{icao:'RKSI',name:'仁川',cls:'a'},{icao:'RKSS',name:'金浦',cls:'a'},{icao:'RKTN',name:'大邱',cls:'a'}],
  philippines: [{icao:'RPLC',name:'克拉克',cls:'r'},{icao:'RPLL',name:'馬尼拉',cls:'r'},{icao:'RPMD',name:'達沃',cls:'a'},{icao:'RPVM',name:'宿霧',cls:'r'}],
  thailand:    [{icao:'VTBS',name:'素萬那普',cls:'r'},{icao:'VTBD',name:'廊曼',cls:'a'},{icao:'VTBU',name:'芭達雅',cls:'a'},{icao:'VTCC',name:'清邁',cls:'r'},{icao:'VTSP',name:'普吉',cls:'a'}],
  vietnam:     [{icao:'VVNB',name:'河內',cls:'r'},{icao:'VVPQ',name:'富國',cls:'r'},{icao:'VVTS',name:'胡志明',cls:'r'},{icao:'VDPP',name:'金邊',cls:'a'},{icao:'VVCR',name:'芽莊',cls:'a'},{icao:'VVDN',name:'峴港',cls:'r'}],
  seasia:      [{icao:'WIII',name:'雅加達',cls:'r'},{icao:'WSSS',name:'新加坡',cls:'r'},{icao:'WADD',name:'峇里島',cls:'r'},{icao:'WARR',name:'泗水',cls:'a'},{icao:'WBGG',name:'古晉',cls:'a'},{icao:'WICA',name:'戈達查帝',cls:'a'},{icao:'WMKP',name:'檳城',cls:'r'},{icao:'WMKK',name:'吉隆坡',cls:'r'}],
  usa:         [],
  pacific:     [{icao:'PGSN',name:'塞班',cls:'a'},{icao:'PGUM',name:'關島',cls:'r'},{icao:'PTRO',name:'帛琉',cls:'a'}],
  canada:      [],
  europe:      []
},

// ════════════════════════════════════════════════════════════════════
// A330-941
// ════════════════════════════════════════════════════════════════════
'A330': {
  taiwan:      [{icao:'RCTP',name:'桃園',cls:'r'},{icao:'RCKH',name:'高雄',cls:'as'},{icao:'RCSS',name:'松山',cls:'as'}],
  hkmacao:     [{icao:'VHHH',name:'香港',cls:'rs'},{icao:'VMMC',name:'澳門',cls:'r'}],
  japan:       [{icao:'RJAA',name:'成田',cls:'r'},{icao:'RJBB',name:'關西',cls:'r'},{icao:'RJCC',name:'新千歲',cls:'r'},{icao:'RJCH',name:'函館',cls:'r'},{icao:'RJFF',name:'福岡',cls:'rs'},{icao:'RJFK',name:'鹿兒島',cls:'a'},{icao:'RJFT',name:'熊本',cls:'r'},{icao:'RJGG',name:'名古屋',cls:'r'},{icao:'RJOT',name:'高松',cls:'r'},{icao:'RJSS',name:'仙台',cls:'r'},{icao:'RJTT',name:'羽田',cls:'a'},{icao:'ROAH',name:'那霸',cls:'r'}],
  korea:       [],
  philippines: [{icao:'RPLC',name:'克拉克',cls:'r'},{icao:'RPLL',name:'馬尼拉',cls:'r'},{icao:'RPVM',name:'宿霧',cls:'r'}],
  thailand:    [{icao:'VTBS',name:'素萬那普',cls:'r'},{icao:'VTBD',name:'廊曼',cls:'a'},{icao:'VTBU',name:'芭達雅',cls:'a'},{icao:'VTCC',name:'清邁',cls:'r'}],
  vietnam:     [{icao:'VVNB',name:'河內',cls:'r'},{icao:'VVPQ',name:'富國',cls:'r'},{icao:'VVTS',name:'胡志明',cls:'r'},{icao:'VDPP',name:'金邊',cls:'a'},{icao:'VVCR',name:'芽莊',cls:'a'},{icao:'VVDN',name:'峴港',cls:'r'}],
  seasia:      [{icao:'WIII',name:'雅加達',cls:'r'},{icao:'WSSS',name:'新加坡',cls:'r'},{icao:'WADD',name:'峇里島',cls:'r'},{icao:'WARR',name:'泗水',cls:'a'},{icao:'WBGG',name:'古晉',cls:'a'},{icao:'WMKP',name:'檳城',cls:'r'},{icao:'WMKK',name:'吉隆坡',cls:'r'}],
  usa:         [],
  pacific:     [],
  canada:      [],
  europe:      []
},

// ════════════════════════════════════════════════════════════════════
// A350-941
// ════════════════════════════════════════════════════════════════════
'A350-900': {
  taiwan:      [{icao:'RCTP',name:'桃園',cls:'r'},{icao:'RCKH',name:'高雄',cls:'as'},{icao:'RCSS',name:'松山',cls:'as'}],
  hkmacao:     [{icao:'VHHH',name:'香港',cls:'rs'},{icao:'VMMC',name:'澳門',cls:'r'}],
  japan:       [{icao:'RJAA',name:'成田',cls:'r'},{icao:'RJBB',name:'關西',cls:'r'},{icao:'RJCC',name:'新千歲',cls:'r'},{icao:'RJFF',name:'福岡',cls:'rs'},{icao:'RJGG',name:'名古屋',cls:'r'},{icao:'RJSS',name:'仙台',cls:'r'},{icao:'ROAH',name:'那霸',cls:'r'},{icao:'RJTT',name:'羽田',cls:'a'}],
  korea:       [{icao:'RKPC',name:'濟州',cls:'a'},{icao:'RKPK',name:'釜山',cls:'as'},{icao:'RKSI',name:'仁川',cls:'a'}],
  philippines: [{icao:'RPLC',name:'克拉克',cls:'r'},{icao:'RPLL',name:'馬尼拉',cls:'r'},{icao:'RPVM',name:'宿霧',cls:'r'}],
  thailand:    [{icao:'VTBS',name:'素萬那普',cls:'r'},{icao:'VTBD',name:'廊曼',cls:'a'},{icao:'VTBU',name:'芭達雅',cls:'a'},{icao:'VTCC',name:'清邁',cls:'a'}],
  vietnam:     [{icao:'VVNB',name:'河內',cls:'r'},{icao:'VVPQ',name:'富國',cls:'r'},{icao:'VVTS',name:'胡志明',cls:'r'},{icao:'VDPP',name:'金邊',cls:'a'},{icao:'VVCR',name:'芽莊',cls:'a'},{icao:'VVDN',name:'峴港',cls:'a'}],
  seasia:      [{icao:'WIII',name:'雅加達',cls:'r'},{icao:'WSSS',name:'新加坡',cls:'r'},{icao:'WADD',name:'峇里島',cls:'a'},{icao:'WARR',name:'泗水',cls:'a'},{icao:'WMKK',name:'吉隆坡',cls:'a'},{icao:'WMKP',name:'檳城',cls:'a'}],
  usa:         [{icao:'KLAX',name:'洛杉磯',cls:'r'},{icao:'KONT',name:'安大略',cls:'rs'},{icao:'KPHX',name:'鳳凰城',cls:'r'},{icao:'KSEA',name:'西雅圖',cls:'r'},{icao:'KSFO',name:'舊金山',cls:'rs'},{icao:'KLAS',name:'拉斯維加斯',cls:'a'},{icao:'KOAK',name:'奧克蘭',cls:'a'},{icao:'KPDX',name:'波特蘭',cls:'a'},{icao:'KSMF',name:'沙加緬度',cls:'a'},{icao:'KTUS',name:'土森',cls:'a'}],
  pacific:     [{icao:'PACD',name:'Cold Bay',cls:'a'},{icao:'PAFA',name:'費爾班克斯',cls:'a'},{icao:'PAKN',name:'King Salmon',cls:'a'},{icao:'PANC',name:'安克拉治',cls:'a'},{icao:'PASY',name:'Shemya',cls:'a'},{icao:'PGSN',name:'塞班',cls:'a'},{icao:'PGUM',name:'關島',cls:'a'},{icao:'PHNL',name:'檀香山',cls:'a'},{icao:'PMDY',name:'中途島',cls:'a'},{icao:'PWAK',name:'威克島',cls:'a'}],
  canada:      [{icao:'CYVR',name:'溫哥華',cls:'a'}],
  europe:      [{icao:'LKPR',name:'布拉格',cls:'r'},{icao:'EDDB',name:'柏林',cls:'a'},{icao:'EDDM',name:'慕尼黑',cls:'a'},{icao:'EPWA',name:'華沙',cls:'a'},{icao:'LOWL',name:'林茲',cls:'a'},{icao:'LOWW',name:'維也納',cls:'a'}]
},

// ════════════════════════════════════════════════════════════════════
// A350-1041
// ════════════════════════════════════════════════════════════════════
'A350-1000': {
  taiwan:      [{icao:'RCTP',name:'桃園',cls:'r'},{icao:'RCKH',name:'高雄',cls:'as'}],
  hkmacao:     [{icao:'VHHH',name:'香港',cls:'as'},{icao:'VMMC',name:'澳門',cls:'as'}],
  japan:       [{icao:'RJAA',name:'成田',cls:'r'},{icao:'RJBB',name:'關西',cls:'a'},{icao:'RJCC',name:'新千歲',cls:'a'},{icao:'RJGG',name:'名古屋',cls:'a'},{icao:'RJSS',name:'仙台',cls:'a'},{icao:'ROAH',name:'那霸',cls:'a'},{icao:'RJTT',name:'羽田',cls:'a'}],
  korea:       [],
  philippines: [{icao:'RPLC',name:'克拉克',cls:'a'},{icao:'RPLL',name:'馬尼拉',cls:'a'}],
  thailand:    [{icao:'VTBS',name:'素萬那普',cls:'r'},{icao:'VTBD',name:'廊曼',cls:'a'},{icao:'VTBU',name:'芭達雅',cls:'a'},{icao:'VTCC',name:'清邁',cls:'a'}],
  vietnam:     [],
  seasia:      [],
  usa:         [],
  pacific:     [],
  canada:      [],
  europe:      []
}

};
