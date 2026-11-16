"""Combined response shapes, without assuming a particular live service grouping rule."""
from copy import deepcopy

import pytest
from test_library import change, raw

from tagcast.library import ConflictError, Library, LibraryError, plan_save, verify, write_requests


def combined(rows=False, flag=True, numbered=False):
    data = raw()
    data['combine_sets'] = flag
    data['library']['tracks']['101'][1] = 91
    if numbered:
        data['library']['tracks']['100'][5] = '1-01'
        data['library']['tracks']['101'][5] = '2-01'
    if rows:
        data['library']['albums']['91'] = ['Original', 4, [101], 1982, 2]
    return data


@pytest.mark.parametrize('rows', [False, True])
@pytest.mark.parametrize('numbered', [False, True])
def test_second_disc_track_changes_target_track_and_verify_original_membership(rows, numbered):
    data = combined(rows, numbered=numbered)
    library = Library(data)
    assert library.active_track_album(101) == 10
    assert 91 not in library.album_ids()
    assert library.combined_view and library.album_writes_blocked
    edit = change('track', 101, 10, title=('Song Two', 'Correct title'))
    edit.update(sourceAlbumId='91', libraryView={'combine_sets': True, 'combined_view': True})
    plan = plan_save(library, [edit])
    assert write_requests(plan, {}) == [('update_track', {'tracks': [{'file_id': 101, 'title': 'Correct title'}]})]
    data['library']['tracks']['101'][0] = 'Correct title'
    assert verify(Library(data), plan, {})[0]['status'] == 'saved'
    data['library']['tracks']['101'][1] = 92
    assert verify(Library(data), plan, {})[0]['status'] == 'unverified'


def test_combined_positions_preserve_disc_and_number_and_do_not_match_other_disc():
    library = Library(combined(numbered=True))
    tracks = library.album_view(10)['tracks']
    assert [(t['disc'], t['track'], t['album_id']) for t in tracks] == [(1, 1, '10'), (2, 1, '91')]
    assert library.album_summary(10)['repeated_numbers'] == 0
    assert library.track_view(101)['disc'] == 2
    assert Library(combined()).track_view(101)['disc'] == 0  # Unknown is not inferred from ID/order.


def test_track_number_edits_stay_blocked_in_both_combined_shapes():
    for data in (combined(), combined(flag=False), {**raw(), 'combine_sets': True}):
        library = Library(data)
        with pytest.raises(LibraryError, match='before changing track numbers'):
            plan_save(library, [change('track', 101, 10, track=(2, 4))])


def test_review_rejects_changed_source_setting_and_shape():
    data = combined()
    edit = change('track', 101, 10, title=('Song Two', 'Correct title'))
    edit.update(sourceAlbumId='91', libraryView={'combine_sets': True, 'combined_view': True})
    for modified in (combined(flag=False), raw(), combined()):
        if modified == data:
            modified['library']['tracks']['101'][1] = 92
        with pytest.raises(ConflictError):
            plan_save(Library(modified), [edit])
    plan = plan_save(Library(data), [edit])
    after = deepcopy(data)
    after['library']['tracks']['101'][0] = 'Correct title'
    after['combine_sets'] = False
    assert verify(Library(after), plan, {})[0]['status'] == 'unverified'


def test_ambiguous_or_missing_membership_never_selects_an_arbitrary_container():
    data = combined()
    data['library']['albums']['12'][2].append(101)
    with pytest.raises(LibraryError, match='ambiguous album membership'):
        plan_save(Library(data), [change('track', 101, 10, title=('Song Two', 'Correct title'))])
    data['library']['albums']['10'][2].remove(101)
    data['library']['albums']['12'][2].remove(101)
    with pytest.raises(LibraryError, match='no longer available'):
        plan_save(Library(data), [change('track', 101, 10, title=('Song Two', 'Correct title'))])


def test_original_disc_identity_and_view_survive_cache_round_trip():
    library = Library(combined(numbered=True))
    cached = Library(library.to_cache())
    assert cached.combined_view
    assert cached.track_view(101) == library.track_view(101)
    assert cached.albums.get(91) is None
    assert cached.track_view(101)['album_id'] == '91'


def test_missing_source_rows_do_not_expand_editing_beyond_one_album_artist():
    with pytest.raises(LibraryError, match='one album or one album artist'):
        plan_save(Library(combined()), [change('track', 101, 10, title=('Song Two', 'Correct title')),
                                      change('track', 102, 11, title=('Elsewhere', 'Other title'))])
